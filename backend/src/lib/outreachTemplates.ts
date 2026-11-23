/**
 * Outreach template → role mapping.
 *
 * When the classifier returns role=null (because the outreach email never
 * named a job title), matchOutreachRole() checks the thread's outbound
 * messages against these entries and returns the configured role if any
 * snippet is found. This lets a recruiter register a vague outreach
 * template once and have all replies classified correctly without manual
 * intervention.
 *
 * To add a new template: paste a distinctive sentence or phrase from the
 * outreach body as the `snippet` and set `role` to the job title.
 * Matching is case-insensitive substring — keep snippets specific enough
 * to avoid false positives against unrelated emails.
 */

export interface OutreachTemplate {
  /** Unique name for logging. */
  name: string;
  /** Distinctive phrase from the outreach body (case-insensitive). */
  snippet: string;
  /** Role title to assign when this template is matched. */
  role: string;
}

export const OUTREACH_TEMPLATES: OutreachTemplate[] = [
  {
    name: 'paul-marketing-team-pml',
    snippet: "adding to our marketing team and want someone who learns fast and is very strong with AI",
    role: 'Product Marketing Lead',
  },
  // Add more entries here as new vague outreach templates are identified.
];

/**
 * Returns the role title if any outbound message body matches a registered
 * template, or null if no match is found.
 */
export function matchOutreachRole(
  outboundBodies: (string | null | undefined)[]
): string | null {
  for (const body of outboundBodies) {
    if (!body) continue;
    const lower = body.toLowerCase();
    for (const template of OUTREACH_TEMPLATES) {
      if (lower.includes(template.snippet.toLowerCase())) {
        return template.role;
      }
    }
  }
  return null;
}
