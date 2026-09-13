// Direction 1's remaining named gap in docs/security-model.md: "docker run
// pulls whatever image reference the user supplies. A malicious image is
// itself a payload, independent of anything the sandbox does at runtime."
// This closes it with the policy decision the doc explicitly left open:
// restrict submittable images to a configured allowlist of repositories,
// checked before a job is ever accepted, let alone reaches a worker's
// `docker run`.
//
// Scope of what this does and does not solve, stated up front rather than
// discovered later:
//   - It stops a user from submitting a wholly arbitrary,
//     attacker-controlled image (some throwaway account's malicious repo)
//     -- the direct version of the attack the security doc names.
//   - It does NOT pin digests. A tag like `python:3.12` can still be
//     re-pointed to different content over time by whoever controls that
//     repo. The default allowlist sticks to Docker Hub's official images
//     specifically because that IS a vetted maintenance process -- but
//     trusting a maintainer is not the same guarantee as a cryptographic
//     digest pin (`python@sha256:...`), which this does not require.
//     Forcing digest pins would close that gap but trades away usability
//     (a user must resolve and supply a digest for every job); that
//     tradeoff is a product decision for whoever operates a real
//     deployment to make deliberately, not something to force silently
//     into an MVP that has no such operator yet.

const DEFAULT_ALLOWED_REPOS = [
  'alpine', 'ubuntu', 'debian', 'python', 'node', 'golang',
  'pytorch/pytorch', 'tensorflow/tensorflow', 'nvidia/cuda',
];

function allowedRepos() {
  // ALLOWED_IMAGE_REPOS lets an operator widen or narrow the list without a
  // code change -- read fresh on every call (not cached at module load) so
  // a test can override it via process.env without needing to reimport.
  const fromEnv = process.env.ALLOWED_IMAGE_REPOS;
  if (!fromEnv) return DEFAULT_ALLOWED_REPOS;
  return fromEnv.split(',').map((s) => s.trim()).filter(Boolean);
}

/** Splits an image reference into its repository and tag/digest --
 * enough for the reference shapes this platform expects (Docker Hub
 * official images and one level of namespace like `pytorch/pytorch`), not
 * a full OCI reference parser (no private registry host:port support). */
export function parseImageRef(image) {
  if (typeof image !== 'string' || image.length === 0) return null;
  const atIndex = image.indexOf('@');
  if (atIndex !== -1) {
    return { repo: image.slice(0, atIndex), ref: image.slice(atIndex + 1), pinned: true };
  }
  const lastColon = image.lastIndexOf(':');
  const lastSlash = image.lastIndexOf('/');
  // A colon before the last '/' is a registry port (host:port/repo), not a
  // tag separator; only a colon AFTER the last '/' actually separates a tag.
  if (lastColon > lastSlash) {
    return { repo: image.slice(0, lastColon), ref: image.slice(lastColon + 1), pinned: false };
  }
  return { repo: image, ref: 'latest', pinned: false };
}

/** Whether `image` is submittable under the configured allowlist. Returns
 * { allowed, reason } rather than a bare boolean so the caller can surface
 * a useful error instead of an unexplained 400. */
export function checkImageAllowed(image) {
  const parsed = parseImageRef(image);
  if (!parsed) return { allowed: false, reason: 'image is required' };
  const repos = allowedRepos();
  if (!repos.includes(parsed.repo)) {
    return {
      allowed: false,
      reason: `image repository '${parsed.repo}' is not on the allowed list (${repos.join(', ')})`,
    };
  }
  return { allowed: true };
}
