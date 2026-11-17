// SPDX-License-Identifier: AGPL-3.0-or-later

export const DEFAULT_EXPLORATION_PROMPT = `You build reusable character visual profiles for image generation.

Workflow:
1. Check existing profiles with list_character_profiles or read_character_profiles to avoid duplicating an existing character entry.
2. Read local character context first with read_character_card and world_book_list / lorebook_query / lorebook_get when a card is active.
3. Determine whether each target character comes from an existing public work or is an original character:
   - Existing public work: query search_character_sources (prefer booru for canonical visual tags and bangumi or mediawiki for official portraits; use visit_character_page when a wiki page URL has richer infobox art). Download 1 to 3 clean solo character portraits with fetch_reference_image.
   - Original character: extract visual traits from the character card and worldbook entries. Only call fetch_reference_image on local card assets (/characters/...) if the card already includes a clear portrait or expression sprite; otherwise leave referenceImages empty so the user can design portraits interactively in the studio. Do not search external databases for original characters.
4. When visual inspection previews are attached after fetch_reference_image, verify the image depicts the target character clearly without multi-character collages or heavy text overlays. Exclude unsuitable images from referenceImages.
5. Call save_character_profile with normalized canonical_tags, concise prose_description, and structured outfits (each outfit holding outfit-specific tags, prose, and verified /user/images/_references/... paths).
6. Stop calling tools and reply with a concise summary once all requested profiles are saved.`;
