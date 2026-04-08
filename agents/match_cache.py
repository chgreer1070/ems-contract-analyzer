"""Shared regex match cache.

Runs every pattern in the PATTERN_ID registry against the text once,
then serves the results to each agent by pattern id. Eliminates the
O(agents x patterns) re-scan cost of the original design.
"""

import bisect


class MatchCache:
    """Pre-scans text with every registered pattern and serves the results.

    Each cached entry is a list of (start, end, group0, groups_tuple) tuples
    rather than raw re.Match objects, to keep the cache cheap to copy and
    to avoid tying callers to the re API.
    """

    def __init__(self, text: str):
        self.text = text
        self._matches: dict = {}
        # Precompute line-start offsets for O(log n) line lookup later.
        self._line_starts = [0]
        for i, c in enumerate(text):
            if c == "\n":
                self._line_starts.append(i + 1)

    def run_all(self, pattern_registry: dict) -> None:
        """Run every pattern in the registry against the text."""
        text = self.text
        for pid, pat in pattern_registry.items():
            self._matches[pid] = [
                (m.start(), m.end(), m.group(0), m.groups())
                for m in pat.finditer(text)
            ]

    def get(self, pattern_id: str) -> list:
        """Return the list of match tuples for a given pattern id.

        Returns an empty list for unknown ids so callers can iterate
        unconditionally.
        """
        return self._matches.get(pattern_id, [])

    def line_for(self, offset: int) -> int:
        """Map a character offset to a 1-indexed line number."""
        if offset < 0:
            return 1
        idx = bisect.bisect_right(self._line_starts, offset) - 1
        return max(idx + 1, 1)

    def __len__(self) -> int:
        return len(self._matches)

    def __contains__(self, pattern_id: str) -> bool:
        return pattern_id in self._matches
