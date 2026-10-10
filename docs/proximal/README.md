# Proximal Claude Code handoff

Extract this ZIP into the existing Proximal repository. All entries are under docs/proximal/; it does not overwrite the app README or source code.

Start with docs/proximal/IMPLEMENTATION_HANDOFF.md. This is the consolidated scope and supersedes the earlier UI, homepage and milestone instructions. The technical appendix is included, so Claude does not need the previous build brief to implement the slice.

The design folder contains the accepted homepage reference and a standalone preview. These are illustrative visual assets, not app logic. Preserve existing working data and routes. Do not embed the preview or copy simulated navigation and counts into production.

Paste into Claude Code:

Read docs/proximal/IMPLEMENTATION_HANDOFF.md in full, then inspect docs/proximal/design/proximal-home-reference.html, the current repository and applicable AGENTS.md files. Implement the Proximal P0 slice using the existing app as the starting point. Preserve working flows and unrelated changes. Use the reference for layout, typography and colours; build the UI with real persisted state. Follow the documented checkpoint, assistance, evidence, scheduling and provider contracts. Work through the milestones, run the required checks and verify the showcase before expanding into P1. Make routine reversible implementation decisions autonomously. Do not stop at a plan or deploy the app. Finish by reporting changes, actual verification results and remaining limitations.

The preview may need internet access for its included icon resources. The final app should reuse its installed icon library.

This package is a build specification and visual reference. It contains no implementation repository, participant results or verified live assessment results.
