from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from quick_notebook.codex import (
    CodexAppServer,
    CodexProtocolError,
    CodexRequestError,
    encode_message,
)


class CodexProtocolTests(unittest.IsolatedAsyncioTestCase):
    def test_encode_is_compact_jsonl_without_version_marker(self) -> None:
        encoded = encode_message({"id": 1, "method": "account/read", "params": {}})

        self.assertTrue(encoded.endswith(b"\n"))
        self.assertNotIn(b"jsonrpc", encoded)
        self.assertEqual(json.loads(encoded), {"id": 1, "method": "account/read", "params": {}})

    def test_rejects_jsonrpc_field(self) -> None:
        with self.assertRaises(CodexProtocolError):
            encode_message({"jsonrpc": "2.0", "method": "initialize"})

    async def test_dispatch_resolves_response(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            client = CodexAppServer(Path(directory))
            future: asyncio.Future[object] = asyncio.get_running_loop().create_future()
            client._pending[7] = future

            await client._dispatch({"id": 7, "result": {"ok": True}})

            self.assertEqual(await future, {"ok": True})

    async def test_dispatch_turns_remote_error_into_exception(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            client = CodexAppServer(Path(directory))
            future: asyncio.Future[object] = asyncio.get_running_loop().create_future()
            client._pending[8] = future

            await client._dispatch({"id": 8, "error": {"message": "not signed in"}})

            with self.assertRaises(CodexRequestError):
                await future

    async def test_event_stream_stops_on_transport_sentinel(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            client = CodexAppServer(Path(directory))
            client._events.put_nowait({"method": "thread/started", "params": {}})
            client._events.put_nowait(None)

            events = [event async for event in client.events()]

            self.assertEqual(events, [{"method": "thread/started", "params": {}}])


if __name__ == "__main__":
    unittest.main()
