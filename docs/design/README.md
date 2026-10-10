# Proximal homepage redesign

Extract these files into docs/design/ in your existing Proximal repository.

- proximal-home-reference.html contains the readable design source, CSS and local example interactions. Give this file to Claude Code.
- proximal-home-preview.html is the standalone browser preview. Open it to inspect the intended appearance. Icons require access to the included public CDN resources.

Paste this instruction into Claude Code:

> Read docs/design/proximal-home-reference.html and redesign the existing Proximal home page to match its layout, typography, spacing and colours. Inspect the existing app first. Reimplement the design using the app's existing React components, Tailwind conventions and real state; do not embed the reference or its preview iframe. Preserve working routes, data loading, import behaviour, review scheduling and the time-budget selector. The reference shows initial demo data, not a source of new application logic. Keep the recommended topic prominent, the remaining session plan compact, the course list secondary, and the offline-mode notice visible but restrained. Keep the page responsive and keyboard accessible. Reuse the installed icon system or equivalent existing icons. Connect every action to the existing behaviour. Implement the change and run the relevant checks.

The preview is an illustrative interface. Its mock navigation, example file selector, static counts and authored demo objectives must not replace real application state. Reuse the visual design, not its simulated behaviour. The production repo is not included in this bundle.
