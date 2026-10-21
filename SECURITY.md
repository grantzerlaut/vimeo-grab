# Security policy

## Supported versions

Only the latest release receives fixes.

## Reporting a vulnerability

Please **don’t** open a public issue for security problems. Instead, use GitHub’s
private reporting: go to the repository’s **Security** tab and choose
**Report a vulnerability**.

Include what an attacker could do, the steps or a test page that shows it, and the
extension and Chrome versions. You should get a first response within a week.

## Scope

Examples of what we want to hear about:

- A web page that can make the extension fetch or download from non-Vimeo hosts,
  write outside the Downloads folder, or send cookies anywhere unexpected.
- A page that can trigger extension actions without the user clicking anything.
- Script or HTML injection into the popup or settings page.
- Anything that lets the extension save DRM-protected content. Refusing DRM is a
  deliberate design decision, so a way around it is a bug.

Out of scope: problems that require a malicious extension or local malware already
running on the machine, and Vimeo’s own services.
