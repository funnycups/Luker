/**
 * Browser-side JS API for the skills REST endpoints.
 *
 * Exposed on `getContext().skills` (st-context.js) and mirrored on CardApp's
 * `ctx.skills`. All path/name validation is handled server-side; this module
 * binds `getRequestHeaders` from core onto the pure `createSkillsApi` factory.
 */

import { getRequestHeaders } from '../../script.js';
import { createSkillsApi } from './api-client.js';

export { createSkillsApi };
export const skillsApi = createSkillsApi({ getRequestHeaders });
