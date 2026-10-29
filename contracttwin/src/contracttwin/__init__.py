"""Source-grounded reader for electronics-manufacturing customer agreements.

The package turns a base agreement and its amendments into a clause register,
a notice calendar, and a pricing / NCNR / excess-and-obsolete exposure summary.
Every fact cites the exact contract text it came from. This is a reading aid.
It is not a legal conclusion, a financial close, or an authorized decision.
"""

from contracttwin.pipeline import analyze

__all__ = ["analyze"]
__version__ = "0.1.0"
