from __future__ import annotations

import asyncio
import re
import socket
import tempfile
import unittest
from pathlib import Path

from jupyter_server.auth import IdentityProvider, User
from tornado.testing import AsyncHTTPTestCase
from tornado.web import Application, StaticFileHandler

from zbook import __version__
from zbook.codex import CodexAppServer, CodexRequestError
from zbook.handlers import IndexHandler


class CodexTransportIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_subprocess_round_trip_events_errors_and_shutdown(self) -> None:
        executable = Path(__file__).parent / "fixtures" / "fake_codex_app_server.py"
        with tempfile.TemporaryDirectory() as directory:
            client = CodexAppServer(Path(directory), executable=str(executable))
            self.addAsyncCleanup(client.close)

            await client.start()
            self.assertTrue(client.running)

            events = client.events().__aiter__()
            initialized = await asyncio.wait_for(anext(events), timeout=2)
            self.assertEqual(initialized["method"], "fake/initialized")
            self.assertEqual(initialized["params"]["clientInfo"]["version"], __version__)

            account = await client.account()
            self.assertFalse(account["requiresOpenaiAuth"])
            thread = await client.start_thread("gpt-5.6-luna")
            self.assertEqual(thread["thread"]["id"], "thread-integration")
            turn = await client.start_turn(
                "thread-integration",
                "Inspect the selected cell",
                model="gpt-5.6-luna",
                effort="medium",
            )
            self.assertEqual(turn["turn"]["id"], "turn-integration")

            turn_event = await asyncio.wait_for(anext(events), timeout=2)
            self.assertEqual(turn_event["method"], "fake/turnStarted")
            self.assertEqual(turn_event["params"]["text"], "Inspect the selected cell")

            with self.assertRaisesRegex(CodexRequestError, "intentional failure"):
                await client.request("fake/error")

            await client.close()
            self.assertFalse(client.running)


class _TestIdentityProvider(IdentityProvider):
    def get_user(self, handler: object) -> User:
        return User("integration-test")


def _can_open_loopback_socket() -> bool:
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    except PermissionError:
        return False
    probe.close()
    return True


@unittest.skipUnless(_can_open_loopback_socket(), "loopback sockets are disabled")
class WebAppIntegrationTests(AsyncHTTPTestCase):
    static_root = Path(__file__).resolve().parents[1] / "src" / "zbook" / "static"

    def get_app(self) -> Application:
        return Application(
            [
                (r"/zbook/", IndexHandler),
                (
                    r"/zbook/assets/(.*)",
                    StaticFileHandler,
                    {"path": str(self.static_root / "assets")},
                ),
            ],
            cookie_secret="zbook-integration-test",
            identity_provider=_TestIdentityProvider(token=""),
            zbook_static_root=str(self.static_root),
        )

    def test_bundled_app_shell_and_hashed_assets_are_served(self) -> None:
        response = self.fetch("/zbook/")

        self.assertEqual(response.code, 200)
        self.assertIn("no-store", response.headers["Cache-Control"])
        html = response.body.decode()
        self.assertIn('<div id="root"></div>', html)
        assets = re.findall(r'(?:href|src)="\./assets/([^"]+)"', html)
        self.assertGreaterEqual(len(assets), 2)

        for asset in assets:
            asset_response = self.fetch(f"/zbook/assets/{asset}")
            self.assertEqual(asset_response.code, 200, asset)
            self.assertTrue(asset_response.body, asset)


if __name__ == "__main__":
    unittest.main()
