"""Run: python3 -m unittest test_server.py (no third-party packages)."""
import unittest
from server import interpret


class ScreenshotRulesTest(unittest.TestCase):
    def read(self, text):
        return interpret([{'text': text, 'confidence': 0.99}])

    def test_vpn_environment_and_code(self):
        result = self.read('Qiyun Connect VPN\nWindows 11\nError code: 691')
        self.assertEqual(result['category'], 'vpn')
        self.assertEqual(result['environment'], 'Windows 11')
        self.assertIn('Error code: 691', result['errorCodes'])

    def test_network(self):
        result = self.read('ERR_INTERNET_DISCONNECTED')
        self.assertEqual(result['category'], 'network')
        self.assertEqual(result['errorCodes'], ['ERR_INTERNET_DISCONNECTED'])

    def test_unknown_and_blank_never_default_to_vpn(self):
        self.assertEqual(self.read('Hello world')['category'], 'unknown')
        self.assertFalse(interpret([])['hasText'])

    def test_permission(self):
        self.assertEqual(self.read('403 Forbidden: Access denied')['category'], 'permission')

    def test_mask_obvious_secrets(self):
        self.assertNotIn('test-password', self.read('password: test-password')['text'])


if __name__ == '__main__':
    unittest.main()
