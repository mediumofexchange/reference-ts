// The one refusal a venue answers with, shared by every venue and every
// construction: a venue that declines to answer or to take a record throws
// `VenueError`, never a malformed-input failure, so no verifier reads a venue
// that did not answer as a fact about a party (`venue.ts`'s `answering`).

export class VenueError extends Error {}
