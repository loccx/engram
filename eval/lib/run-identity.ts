/** readiness that can still switch channels is not an achieved vector regime */
export function unsettledVectorIdentity(value: unknown): boolean {
  return typeof value !== 'string' || value.trim() === '' || value === 'unknown' ||
    value.includes('model-incomplete')
}

/** a missing or uncommitted revision cannot identify the code behind a checkpoint */
export function unidentifiedEngineRevision(value: unknown): boolean {
  return typeof value !== 'string' || value.trim() === '' || value === 'unknown' ||
    value.endsWith('-dirty')
}

/** no cost-saving resume is allowed to turn uncertain identity into matched evidence */
export function resumeIdentityIssue(vectors: unknown, revision: unknown): string | null {
  if (unsettledVectorIdentity(vectors)) return 'achieved vector regime is unverified'
  if (unidentifiedEngineRevision(revision)) return 'engine revision is unidentified'
  return null
}

/** expose dirty state in rows/keys; a dirty suffix is not a fingerprint of the edits */
export function engineRevisionIdentity(git: { sha: string; dirty: boolean }): string {
  return git.sha + (git.dirty ? '-dirty' : '')
}
