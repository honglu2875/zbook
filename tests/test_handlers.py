from __future__ import annotations

import unittest

from zbook.handlers import canonical_notebook_url


class CanonicalUrlTests(unittest.TestCase):
    def test_redirect_adds_trailing_slash_and_preserves_token(self) -> None:
        self.assertEqual(
            canonical_notebook_url("/zbook", "token=example-token"),
            "/zbook/?token=example-token",
        )

    def test_redirect_without_query_does_not_add_question_mark(self) -> None:
        self.assertEqual(canonical_notebook_url("/zbook", ""), "/zbook/")
