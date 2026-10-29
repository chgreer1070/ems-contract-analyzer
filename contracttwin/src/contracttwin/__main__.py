"""Run the reading service on this machine."""

from __future__ import annotations

import os


def main() -> None:
    import uvicorn

    port = int(os.environ.get("PORT", "8080"))
    uvicorn.run("contracttwin.api:app", host="0.0.0.0", port=port)


if __name__ == "__main__":
    main()
