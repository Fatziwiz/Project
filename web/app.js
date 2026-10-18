'use strict';

const el = id => document.getElementById(id);
const MAX_RECORDING_SECONDS = 600;
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let report;
let analysisPending = false;
let scenarios = [];
let importedUrl;
let recordingUrl;
let importVersion = 0;
let durationSource = 'manual';
let activeRecording = null;
let activeRecognition = null;
let pendingStart = false;
let micRequest = 0;
let speechVersion = 0;
let speechActive = false;
let disposed = false;

function updateControls() {
  const busy = pendingStart || Boolean(activeRecording);
  el('start-recording').disabled = busy || !canRecord();
  el('stop-recording').disabled = !busy || Boolean(activeRecording?.stopping);
  el('recognition-consent').disabled = busy || !Recognition;
  el('media').disabled = busy;
  el('duration').disabled = busy;
  el('submit').disabled = busy || analysisPending;
  el('scenario').disabled = busy || !scenarios.length;
  el('speak-prompt').disabled = busy || !scenarios.length || !('speechSynthesis' in window);
  el('speak').disabled = busy || !('speechSynthesis' in window);
  el('stop-speech').disabled = !speechActive;
  el('stop-report-speech').disabled = !speechActive;
}

function canRecord() {
  return window.isSecureContext && typeof navigator.mediaDevices?.getUserMedia === 'function' && typeof window.MediaRecorder === 'function';
}

function stopSpeech(announce = true) {
  speechVersion += 1;
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  if (announce && speechActive) {
    el('voice-status').textContent = 'Озвучивание остановлено.';
    el('report-voice-status').textContent = 'Озвучивание остановлено.';
  }
  speechActive = false;
  updateControls();
}

function speak(text, target) {
  if (!('speechSynthesis' in window)) {
    el(target).textContent = 'Этот браузер не поддерживает озвучивание.';
    return;
  }
  stopSpeech(false);
  const version = speechVersion;
  const message = new SpeechSynthesisUtterance(text);
  message.lang = 'ru-RU';
  const voice = window.speechSynthesis.getVoices().find(item => item.lang.toLowerCase().startsWith('ru'));
  if (voice) message.voice = voice;
  message.onend = () => {
    if (version !== speechVersion) return;
    speechActive = false;
    el(target).textContent = 'Озвучивание завершено.';
    updateControls();
  };
  message.onerror = () => {
    if (version !== speechVersion) return;
    speechActive = false;
    el(target).textContent = 'Не удалось озвучить текст. Проверьте наличие голосов в системе.';
    updateControls();
  };
  speechActive = true;
  el(target).textContent = 'Озвучивание…';
  updateControls();
  window.speechSynthesis.speak(message);
}

el('stop-speech').addEventListener('click', () => stopSpeech());
el('stop-report-speech').addEventListener('click', () => stopSpeech());
el('speak-prompt').addEventListener('click', () => {
  const scenario = scenarios.find(item => item.id === el('scenario').value);
  if (scenario) speak(scenario.prompt, 'voice-status');
});
el('speak').addEventListener('click', () => {
  if (!report) return;
  const tempo = report.words_per_minute === null
    ? 'Для оценки темпа укажите длительность записи.'
    : `Средний темп: ${report.words_per_minute} слов в минуту.`;
  const recommendations = Array.isArray(report.recommendations) ? report.recommendations.join(' ') : '';
  speak(`В тексте ${report.words} слов. Уникальных слов: ${report.unique_words}. Слов заполнителей: ${report.fillers}. ${tempo} ${recommendations} Это анализ текста. Голос и движения пока не анализируются.`, 'report-voice-status');
});

async function loadScenarios() {
  try {
    const response = await fetch('/api/scenarios');
    if (!response.ok) throw new Error('Scenarios unavailable');
    const data = await response.json();
    scenarios = Array.isArray(data.scenarios) ? data.scenarios.filter(item =>
      ['presentation', 'interview', 'defense'].includes(item.id) && typeof item.title === 'string' && typeof item.prompt === 'string') : [];
    if (!scenarios.length) throw new Error('No scenarios');
    el('scenario').replaceChildren(...scenarios.map(scenario => {
      const option = document.createElement('option');
      option.value = scenario.id;
      option.textContent = scenario.title;
      return option;
    }));
    el('scenario-prompt').textContent = scenarios[0].prompt;
  } catch {
    el('scenario').replaceChildren(new Option('Сценарии недоступны', 'presentation'));
    el('scenario-prompt').textContent = 'Не удалось загрузить задания. Можно записать собственное выступление и проанализировать его текст. Для загрузки сценариев обновите страницу.';
  }
  updateControls();
}
el('scenario').addEventListener('change', () => {
  stopSpeech();
  const scenario = scenarios.find(item => item.id === el('scenario').value);
  if (scenario) el('scenario-prompt').textContent = scenario.prompt;
});

function formatTime(seconds) {
  const value = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

function releaseTracks(stream) {
  for (const track of stream.getTracks()) track.stop();
}

function abortRecognition() {
  const current = activeRecognition;
  activeRecognition = null;
  if (current) {
    try { current.engine.abort(); } catch { /* Already stopped. */ }
  }
  el('interim-transcript').hidden = true;
  el('interim-transcript').textContent = '';
}

function startRecognition(session) {
  if (!Recognition || !el('recognition-consent').checked) {
    el('recognition-status').textContent = 'Распознавание выключено. После записи добавьте расшифровку вручную.';
    return;
  }
  let engine;
  try { engine = new Recognition(); }
  catch {
    el('recognition-status').textContent = 'Не удалось запустить распознавание. Запись аудио продолжается; добавьте текст вручную.';
    return;
  }
  const recognition = {engine, session, finalIndexes: new Set(), failed: false};
  activeRecognition = recognition;
  engine.lang = 'ru-RU';
  engine.continuous = true;
  engine.interimResults = true;
  engine.onstart = () => {
    if (activeRecognition !== recognition) return;
    el('recognition-status').textContent = 'Распознавание включено. Подтверждённые слова добавляются в расшифровку.';
  };
  engine.onresult = event => {
    if (activeRecognition !== recognition) return;
    const finalParts = [];
    const interimParts = [];
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      if (result.isFinal) {
        if (recognition.finalIndexes.has(index)) continue;
        recognition.finalIndexes.add(index);
        if (result[0]?.transcript) finalParts.push(result[0].transcript.trim());
      } else if (result[0]?.transcript) interimParts.push(result[0].transcript);
    }
    if (finalParts.length) {
      const existing = el('transcript').value;
      const addition = `${existing && !/\s$/.test(existing) ? ' ' : ''}${finalParts.join(' ')}`;
      const remaining = el('transcript').maxLength - existing.length;
      el('transcript').value = existing + addition.slice(0, Math.max(0, remaining));
      if (addition.length > remaining) {
        recognition.failed = true;
        el('recognition-status').textContent = 'Достигнут предел в 20 000 символов. Запись продолжается; распознавание остановлено.';
        try { engine.stop(); } catch { /* Already stopped. */ }
      }
    }
    el('interim-transcript').textContent = interimParts.length ? `Распознаётся: ${interimParts.join(' ')}` : '';
    el('interim-transcript').hidden = !interimParts.length;
  };
  engine.onerror = event => {
    if (activeRecognition !== recognition) return;
    recognition.failed = true;
    const errors = {
      'not-allowed': 'Браузер не разрешил распознавание речи.',
      'service-not-allowed': 'Сервис распознавания недоступен в этом браузере.',
      'audio-capture': 'Распознавание не получило доступ к микрофону.',
      'network': 'Нет соединения с сервисом распознавания.',
      'no-speech': 'Сервис не распознал речь.',
      'language-not-supported': 'Сервис не поддерживает русский язык.'
    };
    el('recognition-status').textContent = `${errors[event.error] || 'Распознавание остановилось.'} Запись аудио продолжается. Добавьте или исправьте текст вручную.`;
  };
  engine.onend = () => {
    if (activeRecognition !== recognition) return;
    activeRecognition = null;
    el('interim-transcript').hidden = true;
    el('interim-transcript').textContent = '';
    if (!recognition.failed) {
      el('recognition-status').textContent = session.stopping || session.finished
        ? 'Распознавание завершено. Проверьте и при необходимости дополните текст.'
        : 'Браузер завершил распознавание раньше записи. Аудио продолжает записываться; недостающий текст можно добавить вручную.';
    }
  };
  try { engine.start(); }
  catch {
    activeRecognition = null;
    el('recognition-status').textContent = 'Не удалось запустить распознавание. Запись аудио продолжается; добавьте текст вручную.';
  }
}

function finishRecording(session) {
  if (session.finished) return;
  session.finished = true;
  clearInterval(session.timer);
  releaseTracks(session.stream);
  if (activeRecognition?.session === session) {
    try { activeRecognition.engine.stop(); } catch { /* Already stopped. */ }
  }
  if (activeRecording === session) activeRecording = null;
  if (disposed) return;
  const seconds = session.stoppedAt ?? (performance.now() - session.startedAt) / 1000;
  el('recording-timer').textContent = formatTime(seconds);
  el('recording-indicator').classList.remove('is-recording');
  if (session.chunks.length && session.chunks.some(chunk => chunk.size)) {
    if (recordingUrl) URL.revokeObjectURL(recordingUrl);
    const type = session.recorder.mimeType || session.chunks.find(chunk => chunk.type)?.type || 'audio/webm';
    const blob = new Blob(session.chunks, {type});
    recordingUrl = URL.createObjectURL(blob);
    el('recording-preview').src = recordingUrl;
    el('download-recording').href = recordingUrl;
    const extension = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : type.includes('wav') ? 'wav' : 'webm';
    el('download-recording').download = `dialog-answer-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`;
    el('recording-output').hidden = false;
    if (durationSource === session) {
      if (session.hadExistingTranscript) {
        el('duration').value = '';
        el('duration-source').textContent = 'Расшифровка содержит текст до этой записи. Укажите длительность всей расшифровки или оставьте поле пустым.';
      } else {
        el('duration').value = Math.min(86400, Math.max(0.1, seconds)).toFixed(1);
        el('duration-source').textContent = 'Длительность последней записи с микрофона. Можно скорректировать вручную.';
      }
    }
    el('recording-status').textContent = session.failureMessage || (session.limitReached
      ? 'Достигнут предел 10 минут. Запись сохранена в браузере; можно прослушать и скачать.'
      : 'Запись готова. Прослушайте ответ, проверьте расшифровку и запустите анализ.');
  } else {
    el('recording-status').textContent = session.failureMessage || 'Аудиозапись пуста. Попробуйте записать ещё раз или загрузите готовый файл.';
    if (durationSource === session) {
      el('duration').value = '';
      el('duration-source').textContent = 'Запись не получена. Укажите длительность вручную при необходимости.';
    }
  }
  session.chunks = [];
  updateControls();
}

function stopRecording(limitReached = false) {
  if (pendingStart) {
    micRequest += 1;
    pendingStart = false;
    el('recording-status').textContent = 'Начало записи отменено. Если браузер всё ещё показывает запрос, его можно закрыть.';
    updateControls();
    return;
  }
  const session = activeRecording;
  if (!session || session.stopping) return;
  session.stopping = true;
  session.limitReached = limitReached;
  session.stoppedAt = (performance.now() - session.startedAt) / 1000;
  clearInterval(session.timer);
  el('recording-status').textContent = 'Завершаем запись…';
  if (activeRecognition?.session === session) {
    try { activeRecognition.engine.stop(); } catch { /* Recognition may already have ended. */ }
  }
  updateControls();
  try {
    if (session.recorder.state !== 'inactive') session.recorder.stop();
    else finishRecording(session);
  } catch {
    session.failureMessage = 'Браузер не смог завершить запись корректно. Проверьте сохранённый фрагмент или запишите снова.';
    finishRecording(session);
  }
  releaseTracks(session.stream);
}

el('start-recording').addEventListener('click', async () => {
  if (pendingStart || activeRecording || !canRecord()) return;
  stopSpeech();
  abortRecognition();
  el('preview').pause();
  el('recording-preview').pause();
  pendingStart = true;
  const ticket = ++micRequest;
  updateControls();
  el('recording-status').textContent = 'Разрешите доступ к микрофону в запросе браузера…';
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({audio: true});
    if (disposed || ticket !== micRequest) { releaseTracks(stream); return; }
    const types = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'];
    const type = typeof MediaRecorder.isTypeSupported === 'function' ? types.find(item => MediaRecorder.isTypeSupported(item)) : null;
    const recorder = type ? new MediaRecorder(stream, {mimeType: type}) : new MediaRecorder(stream);
    const session = {recorder, stream, chunks: [], startedAt: performance.now(), stopping: false, finished: false, hadExistingTranscript: Boolean(el('transcript').value.trim())};
    recorder.ondataavailable = event => { if (!session.finished && event.data.size) session.chunks.push(event.data); };
    recorder.onstop = () => finishRecording(session);
    recorder.onerror = () => {
      session.failureMessage = 'Произошла ошибка записи. Проверьте сохранённый фрагмент или запишите ответ снова.';
      stopRecording();
    };
    activeRecording = session;
    recorder.start(1000);
    pendingStart = false;
    durationSource = session;
    el('recording-timer').textContent = '00:00';
    el('recording-status').textContent = 'Идёт запись с микрофона. Ответьте на задание, затем нажмите «Остановить».';
    el('recording-indicator').classList.add('is-recording');
    el('duration-source').textContent = 'Длительность появится после остановки записи.';
    session.timer = setInterval(() => {
      const seconds = (performance.now() - session.startedAt) / 1000;
      el('recording-timer').textContent = formatTime(Math.min(seconds, MAX_RECORDING_SECONDS));
      if (seconds >= MAX_RECORDING_SECONDS) stopRecording(true);
    }, 250);
    try { startRecognition(session); }
    catch {
      abortRecognition();
      el('recognition-status').textContent = 'Не удалось запустить распознавание. Запись аудио продолжается; добавьте текст вручную.';
    }
    updateControls();
  } catch (error) {
    if (stream) releaseTracks(stream);
    if (disposed || ticket !== micRequest) return;
    if (activeRecording?.stream === stream) activeRecording = null;
    pendingStart = false;
    const errors = {
      NotAllowedError: 'Доступ к микрофону не разрешён. Проверьте разрешения сайта в браузере.',
      NotFoundError: 'Микрофон не найден. Подключите его и попробуйте снова.',
      NotReadableError: 'Микрофон недоступен. Возможно, его использует другое приложение.',
      SecurityError: 'Браузер запретил доступ к микрофону для этой страницы.'
    };
    el('recording-status').textContent = `${errors[error.name] || 'Не удалось начать аудиозапись в этом браузере.'} Можно загрузить файл и вставить текст вручную.`;
    updateControls();
  }
});
el('stop-recording').addEventListener('click', () => stopRecording());

el('recognition-consent').addEventListener('change', () => {
  el('recognition-status').textContent = el('recognition-consent').checked
    ? 'Распознавание включится только после начала записи. Аудио может передаваться сервису браузера.'
    : 'Распознавание выключено. Можно вставить текст вручную.';
});

el('duration').addEventListener('input', () => {
  durationSource = 'manual';
  el('duration-source').textContent = 'Длительность указана вручную.';
});
el('media').addEventListener('change', () => {
  const file = el('media').files[0];
  const version = ++importVersion;
  el('preview').pause();
  el('preview').removeAttribute('src');
  el('preview').load();
  el('preview').hidden = true;
  if (importedUrl) { URL.revokeObjectURL(importedUrl); importedUrl = null; }
  if (!file) { el('file-status').textContent = 'Файл пока не выбран'; return; }
  if (!/^(audio|video)\//.test(file.type)) {
    el('file-status').textContent = 'Выберите аудио или видео поддерживаемого браузером формата.';
    return;
  }
  importedUrl = URL.createObjectURL(file);
  durationSource = {type: 'import', version, url: importedUrl};
  el('duration').value = '';
  el('preview').src = importedUrl;
  el('preview').hidden = false;
  el('file-status').textContent = file.name;
  el('duration-source').textContent = 'Загружаем длительность выбранного файла…';
});
el('preview').addEventListener('loadedmetadata', () => {
  const preview = el('preview');
  if (durationSource?.type !== 'import' || durationSource.version !== importVersion || preview.currentSrc !== durationSource.url) return;
  if (Number.isFinite(preview.duration) && preview.duration <= 86400) {
    el('duration').value = preview.duration.toFixed(1);
    el('duration-source').textContent = 'Длительность выбранного аудио- или видеофайла. Можно скорректировать вручную.';
  } else {
    el('duration').value = '';
    el('duration-source').textContent = 'Длительность файла недоступна или больше 24 часов. Укажите длительность нужного фрагмента вручную.';
  }
});
el('preview').addEventListener('error', () => {
  if (!importedUrl || el('preview').error?.code === 1) return;
  el('file-status').textContent = 'Браузер не смог воспроизвести этот формат. Можно вставить расшифровку вручную.';
  if (durationSource?.type === 'import') {
    el('duration').value = '';
    el('duration-source').textContent = 'Укажите длительность записи вручную.';
  }
});

el('analysis-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (pendingStart || activeRecording || analysisPending) return;
  analysisPending = true;
  el('submit').disabled = true;
  el('error').textContent = '';
  el('results').hidden = true;
  stopSpeech();
  el('submit').disabled = true;
  try {
    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({text: el('transcript').value, duration: el('duration').value, scenario: el('scenario').value || 'presentation'})
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Ошибка анализа');
    report = result;
    el('metrics').replaceChildren();
    for (const [label, value] of [['Слов', result.words], ['Уникальных слов', result.unique_words], ['Слов-заполнителей', result.fillers], ['Слов в минуту', result.words_per_minute ?? '—']]) {
      const metric = document.createElement('div');
      const number = document.createElement('strong');
      const caption = document.createElement('span');
      number.textContent = value;
      caption.textContent = label;
      metric.append(number, caption);
      el('metrics').append(metric);
    }
    el('result-scenario').textContent = result.scenario?.title || 'Анализ текста';
    el('result-method').textContent = result.method;
    el('limitations').textContent = result.limitations;
    el('recommendations').replaceChildren();
    for (const recommendation of result.recommendations || []) {
      const item = document.createElement('li');
      item.textContent = recommendation;
      el('recommendations').append(item);
    }
    el('results').hidden = false;
    el('report-voice-status').textContent = 'Рекомендации основаны на правилах анализа текста; генеративная модель не подключена.';
    el('results').scrollIntoView({behavior: 'smooth', block: 'start'});
  } catch (error) {
    el('error').textContent = error instanceof SyntaxError
      ? 'Сервер вернул некорректный ответ. Текст сохранён в поле; попробуйте анализ ещё раз.'
      : `Не удалось выполнить анализ: ${error.message}`;
  } finally { analysisPending = false; updateControls(); }
});

el('download').addEventListener('click', () => {
  if (!report) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], {type: 'application/json'}));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'dialog-report.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

window.addEventListener('pagehide', () => {
  disposed = true;
  micRequest += 1;
  abortRecognition();
  stopSpeech(false);
  if (activeRecording) {
    clearInterval(activeRecording.timer);
    if (activeRecording.recorder.state !== 'inactive') activeRecording.recorder.stop();
    releaseTracks(activeRecording.stream);
  }
  if (importedUrl) URL.revokeObjectURL(importedUrl);
  if (recordingUrl) URL.revokeObjectURL(recordingUrl);
});

if (!canRecord()) {
  el('recording-status').textContent = window.isSecureContext
    ? 'Этот браузер не поддерживает запись с микрофона. Загрузите готовый файл или добавьте текст вручную.'
    : 'Для микрофона откройте сайт через HTTPS или localhost. Загрузка файла и ручная расшифровка доступны.';
}
if (!Recognition) {
  el('recognition-status').textContent = 'Этот браузер не поддерживает распознавание речи. Аудиозапись доступна отдельно; текст можно вставить вручную.';
}
if (!('speechSynthesis' in window)) el('voice-status').textContent = 'Этот браузер не поддерживает озвучивание. Задание доступно в тексте.';
updateControls();
loadScenarios();
