# CAD review

Language for reviewing CAD models in Cadsense.

## Language

**CAD comment**:
An agent finding belonging to its originating chat, expressed as text attached to one or more locations in a particular CAD revision, including locations on multiple part instances. Each location identifies a precise point, a small region on a part, or an entire part; users can resolve or dismiss the comment.
_Avoid_: Conversation thread, chat message

**Comment target**:
One explicitly identified location or whole part instance affected by a CAD comment. A comment can have multiple targets, including targets on separate instances of the same part.
_Avoid_: All copies of a part

**Candidate comment location**:
A proposed precise location on an identified part instance that the agent has not yet verified as the spot described by its finding.

**Verified comment location**:
A precise location the agent has checked against an annotated alternate view and judged to represent the intended spot. This verifies where the comment belongs, not whether the finding itself is correct.

**Comment CAD revision**:
The particular CAD model state that a comment describes, including its configuration and component placements. Importing a verified unchanged model again does not create a different comment CAD revision.
_Avoid_: Camera revision, import run

**Resolved CAD comment**:
A finding the user considers addressed across all of its targets. Resolution records the user's review judgment; it does not itself change or verify the CAD model.

**Dismissed CAD comment**:
A finding the user considers to need no action across all of its targets. Dismissal preserves the finding in review history.

**Linked correction**:
A new CAD comment that corrects an earlier finding while preserving the original for review. The link does not change either comment's review state.

**Linked follow-up**:
A new CAD comment with materially new evidence about an existing finding. Rediscovering the same issue without new evidence reuses the existing comment instead.
