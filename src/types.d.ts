/**
 * Ambient declarations for non-code build assets.
 *
 * `docs/tldr.md` imports as raw text so the bundled CLI carries the cheat
 * sheet without a runtime page lookup.
 */
declare module "*.md" {
  const content: string;
  export default content;
}
