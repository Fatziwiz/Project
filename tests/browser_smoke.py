"""Optional browser checks: python3 -m unittest discover -s tests -p browser_smoke.py -v.

Requires Playwright and either system Chromium or a Playwright browser install.
Uses a synthetic microphone; does not validate speech recognition accuracy.
"""
import json
import shutil
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from app import Handler


class VoiceWorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f'http://127.0.0.1:{cls.server.server_port}'
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(
            executable_path=shutil.which('chromium'),
            args=['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
        )

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        self.context = self.browser.new_context(permissions=['microphone'], accept_downloads=True)
        self.page = self.context.new_page()
        self.errors = []
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))

    def tearDown(self):
        self.context.close()
        self.assertEqual(self.errors, [])

    def load(self):
        self.page.goto(self.base)
        expect(self.page.locator('#scenario')).to_be_enabled()

    def test_scenario_analysis_and_json_export(self):
        self.load()
        self.page.select_option('#scenario', 'defense')
        expect(self.page.locator('#scenario-prompt')).to_contain_text('дипломный проект')
        self.page.fill('#transcript', 'Ну привет мир')
        self.page.fill('#duration', '30')
        self.page.click('#submit')
        expect(self.page.locator('#results')).to_be_visible()
        expect(self.page.locator('#recommendations')).to_contain_text('Научная корректность')
        expect(self.page.locator('#metrics')).to_contain_text('6')
        with self.page.expect_download() as download_info:
            self.page.click('#download')
        result = json.loads(Path(download_info.value.path()).read_text())
        self.assertEqual(result['scenario']['id'], 'defense')
        self.assertEqual(result['words_per_minute'], 6)

    def test_local_recording_and_download_without_recognition(self):
        self.page.add_init_script("""
          window.recognitionCalls = 0;
          const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
          navigator.mediaDevices.getUserMedia = async constraints => {
            const stream = await originalGetUserMedia(constraints);
            window.testStream = stream;
            return stream;
          };
          window.SpeechRecognition = class {
            constructor() { window.recognitionCalls++; }
            start() { throw new Error('Recognition must be opt-in'); }
          };
        """)
        self.load()
        expect(self.page.locator('#recognition-consent')).not_to_be_checked()
        self.page.click('#start-recording')
        expect(self.page.locator('#stop-recording')).to_be_enabled()
        self.page.wait_for_function("document.getElementById('recording-timer').textContent !== '00:00'")
        self.page.click('#stop-recording')
        expect(self.page.locator('#recording-preview')).to_be_visible()
        expect(self.page.locator('#start-recording')).to_be_enabled()
        self.assertGreater(float(self.page.input_value('#duration')), 0)
        self.assertEqual(self.page.evaluate('window.recognitionCalls'), 0)
        self.assertTrue(self.page.evaluate("window.testStream.getTracks().every(track => track.readyState === 'ended')"))
        with self.page.expect_download() as download_info:
            self.page.click('#download-recording')
        self.assertGreater(Path(download_info.value.path()).stat().st_size, 0)

    def test_microphone_denied_keeps_manual_analysis_available(self):
        self.page.add_init_script("""
          navigator.mediaDevices.getUserMedia = async () => {
            throw new DOMException('Permission denied', 'NotAllowedError');
          };
        """)
        self.load()
        self.page.click('#start-recording')
        expect(self.page.locator('#start-recording')).to_be_enabled()
        expect(self.page.locator('#stop-recording')).to_be_disabled()
        expect(self.page.locator('#recording-status')).not_to_have_text('Микрофон выключен. Запись до 10 минут.')
        self.page.fill('#transcript', 'Ручной текст после отказа в доступе')
        self.page.click('#submit')
        expect(self.page.locator('#results')).to_be_visible()

    def test_opt_in_recognition_appends_final_text_once(self):
        self.page.add_init_script("""
          window.SpeechRecognition = class {
            constructor() { window.testRecognition = this; }
            start() { if (this.onstart) this.onstart(); }
            stop() { if (this.onend) this.onend(); }
            abort() { if (this.onend) this.onend(); }
          };
        """)
        self.load()
        self.page.fill('#transcript', 'Исходный текст.')
        self.page.check('#recognition-consent')
        self.page.click('#start-recording')
        expect(self.page.locator('#stop-recording')).to_be_enabled()
        self.page.wait_for_function('Boolean(window.testRecognition)')
        self.page.evaluate("""() => {
          const result = [{transcript: 'Распознанная речь'}];
          result.isFinal = true;
          const event = {resultIndex: 0, results: [result]};
          window.testRecognition.onresult(event);
          window.testRecognition.onresult(event);
        }""")
        self.page.wait_for_function("document.getElementById('recording-timer').textContent !== '00:00'")
        self.page.click('#stop-recording')
        expect(self.page.locator('#recording-preview')).to_be_visible()
        expect(self.page.locator('#transcript')).to_have_value('Исходный текст. Распознанная речь')
        expect(self.page.locator('#duration')).to_have_value('')
        expect(self.page.locator('#duration-source')).to_contain_text('всей расшифровки')

    def test_mobile_layout_and_unsupported_recording(self):
        self.page.set_viewport_size({'width': 390, 'height': 844})
        self.page.add_init_script('window.MediaRecorder = undefined;')
        self.load()
        expect(self.page.locator('#start-recording')).to_be_disabled()
        self.assertTrue(self.page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'))
        self.page.fill('#transcript', 'Текст доступен без микрофона')
        self.page.click('#submit')
        expect(self.page.locator('#results')).to_be_visible()

    def test_prompt_and_report_speech_can_be_stopped(self):
        self.page.add_init_script("""
          window.spokenMessages = [];
          Object.defineProperty(window, 'speechSynthesis', {value: {
            cancel() {},
            getVoices() { return []; },
            speak(message) { window.spokenMessages.push(message.text); }
          }});
        """)
        self.load()
        self.page.click('#speak-prompt')
        expect(self.page.locator('#stop-speech')).to_be_enabled()
        self.assertIn('Расскажите о себе', self.page.evaluate('window.spokenMessages[0]'))
        self.page.click('#stop-speech')
        expect(self.page.locator('#stop-speech')).to_be_disabled()
        self.page.fill('#transcript', 'Пример выступления')
        self.page.click('#submit')
        expect(self.page.locator('#results')).to_be_visible()
        self.page.click('#speak')
        expect(self.page.locator('#stop-report-speech')).to_be_enabled()
        self.assertIn('В тексте 2 слов', self.page.evaluate('window.spokenMessages[1]'))
        self.page.click('#stop-report-speech')
        expect(self.page.locator('#stop-report-speech')).to_be_disabled()


if __name__ == '__main__':
    unittest.main()
