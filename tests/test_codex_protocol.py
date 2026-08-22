from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

from zbook.codex import (
    CodexAppServer,
    CodexProtocolError,
    CodexRequestError,
    encode_message,
)
from zbook.codex_handler import choose_default_model, prompt_with_context


class CodexProtocolTests(unittest.IsolatedAsyncioTestCase):
    def test_encode_is_compact_jsonl_without_version_marker(self) -> None:
        encoded = encode_message({"id": 1, "method": "account/read", "params": {}})

        self.assertTrue(encoded.endswith(b"\n"))
        self.assertNotIn(b"jsonrpc", encoded)
        self.assertEqual(json.loads(encoded), {"id": 1, "method": "account/read", "params": {}})

    def test_rejects_jsonrpc_field(self) -> None:
        with self.assertRaises(CodexProtocolError):
            encode_message({"jsonrpc": "2.0", "method": "initialize"})

    def test_prompt_context_names_notebook_and_selected_cell(self) -> None:
        prompt = prompt_with_context(
            "Explain this",
            {
                "notebook": "analysis.ipynb",
                "cellKind": "code",
                "cellId": "cell-42",
                "source": "print(42)",
            },
        )

        self.assertIn("Explain this", prompt)
        self.assertIn("analysis.ipynb", prompt)
        self.assertIn("notebook cell id: cell-42", prompt)
        self.assertIn("```python\nprint(42)", prompt)

    async def test_dispatch_resolves_response(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            client = CodexAppServer(Path(directory))
            future: asyncio.Future[object] = asyncio.get_running_loop().create_future()
            client._pending[7] = future

            await client._dispatch({"id": 7, "result": {"ok": True}})

            self.assertEqual(await future, {"ok": True})

    def test_default_model_prefers_terra_with_medium_effort(self) -> None:
        models = [
            {
                "id": "gpt-default",
                "model": "gpt-default",
                "isDefault": True,
                "defaultReasoningEffort": "low",
                "supportedReasoningEfforts": [{"reasoningEffort": "low"}],
            },
            {
                "id": "gpt-5.6-terra",
                "model": "gpt-5.6-terra",
                "isDefault": False,
                "defaultReasoningEffort": "medium",
                "supportedReasoningEfforts": [
                    {"reasoningEffort": "low"},
                    {"reasoningEffort": "medium"},
                    {"reasoningEffort": "high"},
                ],
            },
        ]

        self.assertEqual(choose_default_model(models), ("gpt-5.6-terra", "medium"))

    async def test_thread_starts_workspace_write_and_ephemeral(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            client = CodexAppServer(Path(directory))
            client.request = AsyncMock(return_value={})  # type: ignore[method-assign]

            await client.start_thread("gpt-5.6-terra")

            params = client.request.await_args.args[1]
            self.assertEqual(params["sandbox"], "workspace-write")
            self.assertEqual(params["approvalPolicy"], "on-request")
            self.assertEqual(params["model"], "gpt-5.6-terra")
            self.assertEqual(params["serviceName"], "zbook")
            self.assertTrue(params["ephemeral"])

    async def test_turn_applies_model_and_reasoning_effort(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            client = CodexAppServer(Path(directory))
            client.request = AsyncMock(return_value={})  # type: ignore[method-assign]

            await client.start_turn(
                "thread-1",
                "Change the selected cell",
                model="gpt-5.6-terra",
                effort="medium",
            )

            params = client.request.await_args.args[1]
            self.assertEqual(params["model"], "gpt-5.6-terra")
            self.assertEqual(params["effort"], "medium")

    async def test_account_controls_use_app_server_endpoints(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            client = CodexAppServer(Path(directory))
            client.request = AsyncMock(return_value={})  # type: ignore[method-assign]

            await client.models()
            await client.rate_limits()
            await client.logout()

            calls = client.request.await_args_list
            self.assertEqual(calls[0].args[0], "model/list")
            self.assertEqual(calls[1].args, ("account/rateLimits/read",))
            self.assertEqual(calls[2].args, ("account/logout",))

    async def test_dispatch_turns_remote_error_into_exception(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            client = CodexAppServer(Path(directory))
            future: asyncio.Future[object] = asyncio.get_running_loop().create_future()
            client._pending[8] = future

            await client._dispatch({"id": 8, "error": {"message": "not signed in"}})

            with self.assertRaises(CodexRequestError):
                await future

    async def test_unanswered_request_times_out_and_is_removed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            client = CodexAppServer(Path(directory))
            client._process = SimpleNamespace(returncode=None)  # type: ignore[assignment]
            client._write = AsyncMock()  # type: ignore[method-assign]

            with self.assertRaisesRegex(CodexRequestError, "request timed out"):
                await client.request("test/hangs", request_timeout=0.001)

            self.assertEqual(client._pending, {})

    async def test_event_stream_stops_on_transport_sentinel(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            client = CodexAppServer(Path(directory))
            client._events.put_nowait({"method": "thread/started", "params": {}})
            client._events.put_nowait(None)

            events = [event async for event in client.events()]

            self.assertEqual(events, [{"method": "thread/started", "params": {}}])


if __name__ == "__main__":
    unittest.main()
