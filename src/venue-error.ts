// The one refusal a venue answers with, shared by every venue and every
// construction: a venue that declines to answer or to take a record throws
// `VenueError`, never a malformed-input failure, so no verifier reads a venue
// that did not answer as a fact about a party (`venue.ts`'s `answering`).

/** A publisher's refusals a caller tells apart by code: a record its funding cannot carry in one transaction
 * (`TOO_LARGE`, which no resend passes) and a full outbox (`FULL`, which a send after settling may pass). Other venue
 * refusals carry no code. */
export type VenueRefusalCode = "TOO_LARGE" | "FULL";

export class VenueError extends Error {
  readonly code: VenueRefusalCode | undefined;
  constructor(message?: string, code?: VenueRefusalCode) {
    super(message);
    this.code = code;
  }
}
