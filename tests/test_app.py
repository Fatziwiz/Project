import json
import threading
import unittest
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from app import Handler, analyze


class TextAnalysisTests(unittest.TestCase):
    def test_unicode_words_and_contextual_fillers(self):
        result = analyze('Ну, сәлем әлем! Hello hello.', 30, 'interview')
        self.assertEqual(result['words'], 5)
        self.assertEqual(result['unique_words'], 4)
        self.assertEqual(result['fillers'], 1)
        self.assertEqual(result['words_per_minute'], 10)
        self.assertEqual(result['scenario']['id'], 'interview')
        self.assertTrue(any('не всегда лишнее' in item for item in result['recommendations']))

    def test_no_duration_does_not_invent_a_pace(self):
        result = analyze('Расскажу о проекте', 0, 'defense')
        self.assertIsNone(result['words_per_minute'])
        self.assertTrue(any('Укажите длительность' in item for item in result['recommendations']))
        self.assertIn('Научная корректность', result['recommendations'][-1])


class APITests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def post(self, data):
        request = Request(self.base + '/api/analyze', data=json.dumps(data).encode(), headers={'Content-Type': 'application/json'})
        try:
            with urlopen(request) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            return error.code, json.load(error)

    def test_scenarios_and_static_files(self):
        with urlopen(self.base + '/api/scenarios') as response:
            scenarios = json.load(response)['scenarios']
        self.assertEqual({item['id'] for item in scenarios}, {'presentation', 'interview', 'defense'})
        for path in ['/', '/app.js', '/style.css']:
            with self.subTest(path=path), urlopen(self.base + path) as response:
                self.assertEqual(response.status, 200)
                self.assertTrue(response.read())

    def test_each_scenario_produces_feedback(self):
        for scenario in ['presentation', 'interview', 'defense']:
            with self.subTest(scenario=scenario):
                status, result = self.post({'text': 'Ну привет мир', 'duration': 30, 'scenario': scenario})
                self.assertEqual(status, 200)
                self.assertEqual(result['words_per_minute'], 6)
                self.assertEqual(result['analysis_type'], 'rule_based_transcript')
                self.assertEqual(result['scenario']['id'], scenario)
                self.assertGreater(len(result['recommendations']), 1)

    def test_invalid_inputs_are_rejected(self):
        invalid = [[], {}, {'text': ' '}, {'text': 'a' * 20001}, {'text': 3}, {'text': 'a', 'scenario': 'unknown'}, {'text': 'a', 'scenario': []}]
        invalid += [{'text': 'a', 'duration': value} for value in [-1, 0.01, '5e-324', 86401, 'NaN', 'Infinity', True, [], {}]]
        for data in invalid:
            with self.subTest(data=str(data)[:70]):
                status, result = self.post(data)
                self.assertEqual(status, 400)
                self.assertIn('error', result)

    def test_duration_boundary_and_omission(self):
        status, result = self.post({'text': 'one', 'duration': 0.1})
        self.assertEqual(status, 200)
        self.assertEqual(result['words_per_minute'], 600)
        status, result = self.post({'text': 'one'})
        self.assertEqual(status, 200)
        self.assertIsNone(result['words_per_minute'])

    def test_raw_malformed_and_oversized_requests(self):
        for payload, content_type, expected in [(b'{', 'application/json', 400), (b'{}', 'text/plain', 415), (b'x' * 100001, 'application/json', 400)]:
            request = Request(self.base + '/api/analyze', data=payload, headers={'Content-Type': content_type})
            with self.subTest(size=len(payload)), self.assertRaises(HTTPError) as error:
                urlopen(request)
            self.assertEqual(error.exception.code, expected)


if __name__ == '__main__':
    unittest.main()
