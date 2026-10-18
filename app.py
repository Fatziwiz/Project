"""Local development server: python3 app.py."""
import json
import math
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).parent / 'web'
SCENARIOS = {
    'presentation': {
        'id': 'presentation',
        'title': 'Самопрезентация',
        'prompt': 'Расскажите о себе: чем вы занимаетесь, какой проект считаете самым важным и чему хотите научиться. Попробуйте уложиться в одну минуту.',
    },
    'interview': {
        'id': 'interview',
        'title': 'Собеседование',
        'prompt': 'Вспомните сложную задачу. Опишите ситуацию, вашу роль, конкретные действия и результат. Ответьте так, как ответили бы на собеседовании.',
    },
    'defense': {
        'id': 'defense',
        'title': 'Защита диплома',
        'prompt': 'Какую проблему решает ваш дипломный проект? Объясните выбранный метод, отличие от существующих решений и способ проверки результата.',
    },
}


def analyze(text, duration, scenario='presentation'):
    words = re.findall(r"[^\W\d_]+(?:[-’'][^\W\d_]+)*", text.lower(), re.UNICODE)
    fillers = {'ну', 'типа', 'короче', 'ээ', 'эм', 'uh', 'um'}
    filler_count = sum(word in fillers for word in words)
    words_per_minute = round(len(words) * 60 / duration, 1) if duration else None
    recommendations = []
    if len(words) < 40:
        recommendations.append('В расшифровке меньше 40 слов. Для следующей попытки добавьте конкретный пример; по короткому фрагменту трудно сравнивать выступления.')
    if filler_count:
        recommendations.append(f'В тексте найдено {filler_count} слов из ограниченного словаря заполнителей. Прослушайте соответствующие фразы и решите, где уместнее пауза: например, слово «ну» не всегда лишнее.')
    if duration:
        recommendations.append(f'Расчётный темп — {words_per_minute} слов в минуту с учётом всей указанной длительности. Прослушайте запись и проверьте, удобно ли следить за мыслью; универсального целевого темпа нет.')
    else:
        recommendations.append('Укажите длительность именно этого выступления, чтобы рассчитать средний темп речи.')
    recommendations.append({
        'presentation': 'В следующем дубле попробуйте структуру «кто я → один пример опыта → моя цель». Это упражнение; содержание вашего ответа автоматически не оценивалось.',
        'interview': 'Сверьте ответ со структурой «ситуация → задача → действия → результат». Это подсказка к упражнению; наличие этих частей автоматически не проверялось.',
        'defense': 'Подготовьте по одному предложению о проблеме, методе, результате и способе его проверки. Научная корректность ответа автоматически не оценивалась.',
    }[scenario])
    return {
        'words': len(words),
        'unique_words': len(set(words)),
        'fillers': filler_count,
        'words_per_minute': words_per_minute,
        'scenario': SCENARIOS[scenario],
        'recommendations': recommendations,
        'analysis_type': 'rule_based_transcript',
        'method': 'Лексический подсчёт по предоставленному тексту. Темп рассчитан по указанной длительности; паузы не исключаются.',
        'limitations': 'Это базовый текстовый анализ, а не AI-анализ аудио или видео. Словарь заполнителей ограничен; эмоции, жесты и достоверность высказываний не определяются.',
    }


class Handler(BaseHTTPRequestHandler):
    def respond_json(self, result, status=200):
        payload = json.dumps(result, ensure_ascii=False, allow_nan=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path == '/api/scenarios':
            self.respond_json({'scenarios': list(SCENARIOS.values())})
            return
        files = {'/': ('index.html', 'text/html; charset=utf-8'), '/style.css': ('style.css', 'text/css; charset=utf-8'), '/app.js': ('app.js', 'text/javascript; charset=utf-8')}
        if self.path not in files:
            self.send_error(404)
            return
        name, mime = files[self.path]
        self.send_response(200)
        self.send_header('Content-Type', mime)
        self.end_headers()
        self.wfile.write((ROOT / name).read_bytes())

    def do_POST(self):
        if self.path != '/api/analyze':
            self.send_error(404)
            return
        try:
            if self.headers.get_content_type() != 'application/json':
                self.respond_json({'error': 'Ожидается Content-Type: application/json.'}, 415)
                return
            length = int(self.headers.get('Content-Length', 0))
            if not 0 < length <= 100_000:
                raise ValueError('Слишком большой или пустой запрос')
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict):
                raise ValueError('Ожидается объект JSON')
            text = data.get('text', '')
            raw_duration = data.get('duration', 0)
            if isinstance(raw_duration, bool) or not isinstance(raw_duration, (str, int, float, type(None))):
                raise ValueError('Некорректная длительность')
            duration = float(raw_duration or 0)
            scenario = data.get('scenario', 'presentation')
            if not isinstance(scenario, str) or scenario not in SCENARIOS:
                raise ValueError('Неизвестный сценарий')
            if not isinstance(text, str) or len(text) > 20_000 or not text.strip() or not math.isfinite(duration) or not (duration == 0 or 0.1 <= duration <= 86400):
                raise ValueError('Укажите текст и корректную длительность')
            result = analyze(text, duration, scenario)
            status = 200
        except (ValueError, TypeError, OverflowError):
            status, result = 400, {'error': 'Укажите текст до 20 000 символов, известный сценарий и длительность от 0,1 до 86400 секунд (или 0 без расчёта темпа).'}
        self.respond_json(result, status)


if __name__ == '__main__':
    print('Development server listening on port 8000', flush=True)
    ThreadingHTTPServer(('0.0.0.0', 8000), Handler).serve_forever()
