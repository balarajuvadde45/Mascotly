# Security Policy

## Reporting a vulnerability

Do **not** open a public GitHub issue for security vulnerabilities. Use GitHub's
**"Report a vulnerability"** button on the Security tab of this repository, or
contact the maintainers directly through the contact listed on the repository
profile.

You'll get an acknowledgment within 72 hours and a fix or mitigation plan as
soon as we can — typically within 14 days for high-severity issues.

## Scope notes

- The mascot **brain** follows only indexed knowledge; it is an assistant
  boundary, not a security boundary. Do not place secrets in knowledge sources.
- **REA integration** executes a local CLI — only expose it to holders of the
  admin or app-secret keys.
- See [docs/security.md](docs/security.md) for the full threat model.
