from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from zbook.codex import (
    CODEX_STREAM_LIMIT_BYTES,
    NOTEBOOK_DYNAMIC_TOOLS,
    NOTEBOOK_TOOL_INSTRUCTIONS,
    CodexAppServer,
    CodexProtocolError,
    CodexRequestError,
    CodexUnavailable,
    encode_message,
)
from zbook.codex_handler import (
    choose_default_model,
    dynamic_tool_response,
    prompt_with_context,
    thread_messages,
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

    def test_prompt_context_names_notebook_and_selected_cell_without_source(self) -> None:
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
        self.assertNotIn("print(42)", prompt)

    async def test_dispatch_resolves_response(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            client = CodexAppServer(Path(directory))
            future: asyncio.Future[object] = asyncio.get_running_loop().create_future()
            client._pending[7] = future

            await client._dispatch({"id": 7, "result": {"ok": True}})

            self.assertEqual(await future, {"ok": True})

    def test_default_model_prefers_luna_with_medium_effort(self) -> None:
        models = [
            {
                "id": "gpt-5.6-terra",
                "model": "gpt-5.6-terra",
                "isDefault": True,
                "defaultReasoningEffort": "low",
                "supportedReasoningEfforts": [{"reasoningEffort": "low"}],
            },
            {
                "id": "gpt-5.6-luna",
                "model": "gpt-5.6-luna",
                "isDefault": False,
                "defaultReasoningEffort": "medium",
                "supportedReasoningEfforts": [
                    {"reasoningEffort": "low"},
                    {"reasoningEffort": "medium"},
                    {"reasoningEffort": "high"},
                ],
            },
        ]

        self.assertEqual(choose_default_model(models), ("gpt-5.6-luna", "medium"))

    async def test_thread_starts_workspace_write_and_persistent(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            client = CodexAppServer(Path(directory))
            client.request = AsyncMock(return_value={})  # type: ignore[method-assign]

            await client.start_thread("gpt-5.6-terra")

            params = client.request.await_args.args[1]
            self.assertEqual(params["sandbox"], "workspace-write")
            self.assertEqual(params["approvalPolicy"], "on-request")
            self.assertEqual(params["model"], "gpt-5.6-terra")
            self.assertEqual(params["serviceName"], "zbook")
            self.assertFalse(params["ephemeral"])
            self.assertEqual(params["dynamicTools"], NOTEBOOK_DYNAMIC_TOOLS)
            self.assertEqual(params["developerInstructions"], NOTEBOOK_TOOL_INSTRUCTIONS)
            self.assertEqual(
                {tool["name"] for tool in params["dynamicTools"]},
                {
                    "zbook_notebook_read",
                    "zbook_notebook_lock",
                    "zbook_notebook_propose",
                    "zbook_notebook_apply",
                },
            )

    def test_notebook_tools_expose_turn_locks_and_source_light_reordering(self) -> None:
        tools = {tool["name"]: tool for tool in NOTEBOOK_DYNAMIC_TOOLS}
        read_schema = tools["zbook_notebook_read"]["inputSchema"]
        self.assertEqual(read_schema["properties"]["includeSource"]["type"], "boolean")
        self.assertFalse(read_schema["properties"]["includeSource"]["default"])
        self.assertEqual(read_schema["properties"]["cellIds"]["maxItems"], 20)
        self.assertTrue(read_schema["properties"]["cellIds"]["uniqueItems"])

        lock_schema = tools["zbook_notebook_lock"]["inputSchema"]
        self.assertEqual(lock_schema["properties"]["action"]["enum"], ["lock", "unlock"])
        self.assertTrue(lock_schema["properties"]["cellIds"]["uniqueItems"])
        self.assertEqual(lock_schema["properties"]["cellIds"]["maxItems"], 100)

        proposal_schemas = tools["zbook_notebook_propose"]["inputSchema"]["oneOf"]
        proposal_actions = {
            schema["properties"]["action"]["const"] for schema in proposal_schemas
        }
        self.assertEqual(
            proposal_actions,
            {"insert_cell", "stage_hunk", "replace_proposal", "discard_proposal"},
        )
        insert_schema = next(
            schema
            for schema in proposal_schemas
            if schema["properties"]["action"]["const"] == "insert_cell"
        )
        self.assertEqual(insert_schema["properties"]["expectedProposalRevision"]["const"], 0)
        self.assertEqual(insert_schema["properties"]["afterCellId"]["type"], ["string", "null"])
        hunk_schema = next(
            schema
            for schema in proposal_schemas
            if schema["properties"]["action"]["const"] == "stage_hunk"
        )
        self.assertEqual(hunk_schema["properties"]["startLine"]["minimum"], 1)
        self.assertEqual(hunk_schema["properties"]["oldLines"]["maxItems"], 400)

        operation_schemas = tools["zbook_notebook_apply"]["inputSchema"]["properties"][
            "operations"
        ]["items"]["oneOf"]
        operations = {schema["properties"]["op"]["const"] for schema in operation_schemas}
        self.assertEqual(
            operations,
            {"replace_source", "set_kind", "insert_after", "delete", "move_after", "swap"},
        )
        self.assertIn("includeSource false", NOTEBOOK_TOOL_INSTRUCTIONS)
        self.assertIn(
            "immediately lock the likely set",
            NOTEBOOK_TOOL_INSTRUCTIONS,
        )
        self.assertIn("release automatically", NOTEBOOK_TOOL_INSTRUCTIONS)
        self.assertIn("availableActions", NOTEBOOK_TOOL_INSTRUCTIONS)
        self.assertIn("arguments returned in nextAction", NOTEBOOK_TOOL_INSTRUCTIONS)
        self.assertIn("once per small coherent hunk", NOTEBOOK_TOOL_INSTRUCTIONS)
        self.assertIn("proposal on the user's behalf", NOTEBOOK_TOOL_INSTRUCTIONS)
        self.assertIn("1|import numpy as np", NOTEBOOK_TOOL_INSTRUCTIONS)
        self.assertIn("Everything after the first | is exact source", NOTEBOOK_TOOL_INSTRUCTIONS)
        self.assertIn(
            "not a duplicate source field or per-line JSON objects",
            NOTEBOOK_TOOL_INSTRUCTIONS,
        )
        self.assertIn("never use insert_after", NOTEBOOK_TOOL_INSTRUCTIONS)
        self.assertIn("announce a successful lock", NOTEBOOK_TOOL_INSTRUCTIONS)
        self.assertIn("capability-discovery endpoint", tools["zbook_notebook_read"]["description"])
        self.assertIn("numberedSource", tools["zbook_notebook_read"]["description"])
        self.assertGreater(CODEX_STREAM_LIMIT_BYTES, 64 * 1024)

    async def test_thread_resume_and_read_use_app_server_endpoints(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            client = CodexAppServer(Path(directory))
            client.request = AsyncMock(return_value={})  # type: ignore[method-assign]

            await client.read_thread("thread-1")
            await client.resume_thread("thread-1", "gpt-5.6-luna")

            calls = client.request.await_args_list
            self.assertEqual(
                calls[0].args,
                ("thread/read", {"threadId": "thread-1", "includeTurns": True}),
            )
            self.assertEqual(calls[1].args[0], "thread/resume")
            self.assertEqual(calls[1].args[1]["threadId"], "thread-1")
            self.assertEqual(calls[1].args[1]["model"], "gpt-5.6-luna")
            self.assertEqual(calls[1].args[1]["dynamicTools"], NOTEBOOK_DYNAMIC_TOOLS)

    def test_thread_messages_hide_private_context_and_restore_activity(self) -> None:
        stored_prompt = prompt_with_context(
            "Explain this",
            {
                "notebook": "analysis.ipynb",
                "cellKind": "code",
                "cellId": "cell-42",
                "source": 'print("before")\n\nZbook context supplied by the user:\nprint("after")',
            },
        )
        messages = thread_messages(
            {
                "turns": [
                    {
                        "items": [
                            {
                                "id": "user-1",
                                "type": "userMessage",
                                "content": [{"type": "text", "text": stored_prompt}],
                            },
                            {
                                "id": "cmd-1",
                                "type": "commandExecution",
                                "command": "pwd",
                                "aggregatedOutput": "/workspace\n",
                                "status": "completed",
                            },
                            {
                                "id": "file-1",
                                "type": "fileChange",
                                "changes": [{"path": "analysis.py", "kind": "update"}],
                                "status": "completed",
                            },
                            {
                                "id": "tool-1",
                                "type": "dynamicToolCall",
                                "tool": "zbook_notebook_read",
                                "status": "completed",
                                "success": True,
                            },
                            {
                                "id": "tool-2",
                                "type": "dynamicToolCall",
                                "tool": "zbook_notebook_propose",
                                "status": "completed",
                                "success": True,
                            },
                            {
                                "id": "agent-1",
                                "type": "agentMessage",
                                "text": "Here is the explanation.",
                            },
                        ]
                    }
                ]
            }
        )

        self.assertEqual(
            messages,
            [
                {"id": "user-1", "role": "user", "text": "Explain this"},
                {
                    "id": "activity-cmd-1",
                    "role": "activity",
                    "text": "$ pwd\n/workspace\n✓ completed\n",
                },
                {
                    "id": "activity-file-1",
                    "role": "activity",
                    "text": "Editing analysis.py\n✓ Changes applied\n",
                },
                {
                    "id": "activity-tool-1",
                    "role": "activity",
                    "text": "Reading cells through Zbook…\n✓ Zbook notebook tool completed\n",
                },
                {
                    "id": "activity-tool-2",
                    "role": "activity",
                    "text": (
                        "Staging a cell proposal through Zbook…\n"
                        "✓ Zbook notebook tool completed\n"
                    ),
                },
                {
                    "id": "agent-1",
                    "role": "assistant",
                    "text": "Here is the explanation.",
                },
            ],
        )
        rendered = "\n".join(message["text"] for message in messages)
        self.assertNotIn("Zbook context supplied by the user", rendered)
        self.assertNotIn("analysis.ipynb", rendered)
        self.assertNotIn("cell-42", rendered)

    def test_dynamic_tool_response_matches_app_server_shape(self) -> None:
        response = dynamic_tool_response(True, {"documentRevision": 7, "saved": True})

        self.assertTrue(response["success"])
        self.assertEqual(response["contentItems"][0]["type"], "inputText")
        self.assertEqual(
            json.loads(response["contentItems"][0]["text"]),
            {"documentRevision": 7, "saved": True},
        )

    def test_dynamic_tool_response_rejects_an_oversized_payload(self) -> None:
        with patch("zbook.codex_handler._MAX_DYNAMIC_TOOL_RESPONSE_BYTES", 32):
            response = dynamic_tool_response(True, {"numberedSource": f"1|{'x' * 64}"})

        self.assertFalse(response["success"])
        result = json.loads(response["contentItems"][0]["text"])
        self.assertEqual(result["error"], "tool_result_too_large")
        self.assertGreater(result["responseBytes"], 32)

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

    async def test_stdout_reader_accepts_a_jsonl_frame_larger_than_64_kib(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            client = CodexAppServer(Path(directory))
            reader = asyncio.StreamReader(limit=CODEX_STREAM_LIMIT_BYTES)
            event = {"method": "large/event", "params": {"text": "x" * 100_000}}
            reader.feed_data(encode_message(event))
            reader.feed_eof()
            client._process = SimpleNamespace(stdout=reader, returncode=0)  # type: ignore[assignment]

            await client._read_stdout()

            self.assertEqual(await client._events.get(), event)
            self.assertIsNone(await client._events.get())

    async def test_stdout_failure_stops_pending_requests_and_reports_transport_error(self) -> None:
        class FailingStream:
            def __aiter__(self) -> FailingStream:
                return self

            async def __anext__(self) -> bytes:
                raise ValueError("Separator is not found, and chunk exceed the limit")

        with tempfile.TemporaryDirectory() as directory:
            client = CodexAppServer(Path(directory))
            terminate = Mock()
            client._process = SimpleNamespace(  # type: ignore[assignment]
                stdout=FailingStream(),
                returncode=None,
                terminate=terminate,
            )
            future: asyncio.Future[object] = asyncio.get_running_loop().create_future()
            client._pending[9] = future

            await client._read_stdout()

            event = await client._events.get()
            self.assertEqual(event["method"], "client/transportError")
            self.assertIn("32 MiB", event["params"]["message"])
            self.assertIsNone(await client._events.get())
            with self.assertRaises(CodexUnavailable):
                await future
            self.assertFalse(client.running)
            with self.assertRaises(CodexUnavailable):
                await client.request("turn/interrupt")
            terminate.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
