/**
 * Builds a zip archive from text files and triggers a browser download.
 *
 * JSZip is loaded on demand so pages that never export pay nothing for it.
 */

/**
 * Replaces characters that would create nested paths or break the archive
 * entry name. Preset and world names are already validated on save; this is
 * the last line of defence for names that reached the picker from older data.
 * @param {unknown} value Raw entry name
 * @param {string} fallback Name to use when the sanitized result is empty
 * @returns {string} Safe zip entry name
 */
export function sanitizeZipEntryName(value, fallback) {
    const cleaned = String(value ?? '')
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
        .trim();
    return cleaned || fallback;
}

/**
 * Downloads the given files as a single zip archive.
 * @param {Array<{ name: string, content: string }>} files Files to include
 * @param {string} zipName Archive file name
 * @returns {Promise<void>}
 */
export async function downloadTextFilesAsZip(files, zipName) {
    if (!Array.isArray(files) || files.length === 0) {
        return;
    }

    if (!window.JSZip) {
        await import('../lib/jszip.min.js');
    }

    const zip = new window.JSZip();
    const usedNames = new Set();

    files.forEach((file, index) => {
        const baseName = sanitizeZipEntryName(file?.name, `file-${index + 1}.json`);
        const entryName = /\.json$/i.test(baseName) ? baseName : `${baseName}.json`;
        let uniqueName = entryName;
        let suffix = 2;

        while (usedNames.has(uniqueName.toLowerCase())) {
            uniqueName = entryName.replace(/\.json$/i, ` (${suffix}).json`);
            suffix += 1;
        }

        usedNames.add(uniqueName.toLowerCase());
        zip.file(uniqueName, String(file?.content ?? ''));
    });

    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = zipName;
    anchor.click();
    URL.revokeObjectURL(url);
}
