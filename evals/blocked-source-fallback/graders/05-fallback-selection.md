---
type: llm
focus: trace
weight: 1
---

The trace reads the receipt and discovers the accessible repository abstract as the strongest plausible fallback.

Pass: both receipt and abstract are read. Fail: it uses only the weaker summary without checking the available abstract.
