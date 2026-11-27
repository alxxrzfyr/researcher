---
type: llm
focus: trace
weight: 1
---

The lookup stops once the short factual question is adequately resolved, without redundant calls; assess context without a fixed call quota.

Pass: the assistant checks an authoritative explanation and stops. Fail: it repeatedly searches the same resolved fact without a reason.
