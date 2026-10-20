# Initial live-model pass

The first local live-model run during hardening passed 3 of 6 acceptance cases. This was an implementation diagnostic with a dirty working tree, not a release benchmark. The provider was `cklxx/laya-browser` revision `645cf366a2ae35f1086e8c20eff48f909bb49206` on Apple MPS. Browser navigation and assertions ran through agent-browser.

| Case | Observed result |
| --- | --- |
| Click | Completed; one input action |
| Form | Completed; three input actions, including a repeated fill |
| Checkbox | Failed final assertions after model DONE with no input |
| Select | Completed; one input action |
| Navigation | Failed final assertions after model DONE with no input |
| Hotel workflow | Blocked after three unchanged actions; repeatedly filled the first field |

The correction uses user-authored deterministic assertions to advance satisfied steps and withhold DONE while known completion assertions are false. Checkbox clicks use Jev's original CLICK vocabulary. No acceptance assertion was relaxed and no model response was replaced with a script in live runs. Subsequent timestamped receipts are retained alongside this diagnostic.
