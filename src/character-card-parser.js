import fs from 'node:fs';
import { Buffer } from 'node:buffer';

import encode from './png/encode.js';
import extract from 'png-chunks-extract';
import PNGtext from 'png-chunk-text';

/**
 * Keyword of a tEXt chunk payload without materializing its text.
 *
 * A tEXt payload is `keyword\0text`, and the text can be a multi-megabyte
 * base64 copy of the card JSON, so only the keyword slice is decoded here.
 *
 * @param {Uint8Array} payload Raw tEXt chunk payload
 * @returns {string}
 */
function readTextChunkKeyword(payload) {
    const separator = payload.indexOf(0);
    if (separator < 0) {
        return '';
    }
    return Buffer.from(payload.buffer, payload.byteOffset, separator).toString('latin1');
}

/**
 * Decodes a tEXt chunk payload into its keyword and text in one pass.
 *
 * The upstream decoder appends the payload one character at a time, which
 * allocates a string per byte plus a cons cell per join. Card JSON is stored
 * as a base64 tEXt payload, so a card carrying a large lorebook turned a few
 * megabytes of metadata into hundreds of megabytes of garbage on every read.
 * Slicing the payload and decoding it as latin1 keeps the cost linear in the
 * payload size.
 *
 * @param {Uint8Array} payload Raw tEXt chunk payload
 * @returns {{keyword: string, text: string}}
 */
function decodeTextChunk(payload) {
    const separator = payload.indexOf(0);
    if (separator < 0) {
        throw new Error('Invalid tEXt chunk: missing keyword separator');
    }
    if (payload.indexOf(0, separator + 1) >= 0) {
        throw new Error('Invalid NULL character found. 0x00 character is not permitted in tEXt content');
    }

    const keyword = Buffer.from(payload.buffer, payload.byteOffset, separator).toString('latin1');
    const text = Buffer.from(payload.buffer, payload.byteOffset + separator + 1, payload.length - separator - 1).toString('latin1');
    return { keyword, text };
}

/**
 * Writes Character metadata to a PNG image buffer.
 * Writes only 'chara', 'ccv3' is not supported and removed not to create a mismatch.
 * @param {Buffer} image PNG image buffer
 * @param {string} data Character data to write
 * @returns {Buffer} PNG image buffer with metadata
 */
export const write = (image, data) => {
    const chunks = extract(image);
    const tEXtChunks = chunks.filter(chunk => chunk.name === 'tEXt');

    // Remove existing tEXt chunks
    for (const tEXtChunk of tEXtChunks) {
        const keyword = readTextChunkKeyword(tEXtChunk.data).toLowerCase();
        if (keyword === 'chara' || keyword === 'ccv3') {
            chunks.splice(chunks.indexOf(tEXtChunk), 1);
        }
    }

    // Add new v2 chunk before the IEND chunk
    const base64EncodedData = Buffer.from(data, 'utf8').toString('base64');
    chunks.splice(-1, 0, PNGtext.encode('chara', base64EncodedData));

    // Try adding v3 chunk before the IEND chunk
    try {
        //change v2 format to v3
        const v3Data = JSON.parse(data);
        v3Data.spec = 'chara_card_v3';
        v3Data.spec_version = '3.0';

        const base64EncodedData = Buffer.from(JSON.stringify(v3Data), 'utf8').toString('base64');
        chunks.splice(-1, 0, PNGtext.encode('ccv3', base64EncodedData));
    } catch (error) {
        // Ignore errors when adding v3 chunk
    }

    const newBuffer = Buffer.from(encode(chunks));
    return newBuffer;
};

/**
 * Reads Character metadata from a PNG image buffer.
 * Supports both V2 (chara) and V3 (ccv3). V3 (ccv3) takes precedence.
 * @param {Buffer} image PNG image buffer
 * @returns {string} Character data
 */
export const read = (image) => {
    const chunks = extract(image);

    const textChunks = chunks.filter((chunk) => chunk.name === 'tEXt');

    if (textChunks.length === 0) {
        console.error('PNG metadata does not contain any text chunks.');
        throw new Error('No PNG metadata.');
    }

    const findChunk = (keyword) => textChunks.find((chunk) => readTextChunkKeyword(chunk.data).toLowerCase() === keyword);
    const dataChunk = findChunk('ccv3') ?? findChunk('chara');

    if (dataChunk) {
        return Buffer.from(decodeTextChunk(dataChunk.data).text, 'base64').toString('utf8');
    }

    console.error('PNG metadata does not contain any character data.');
    throw new Error('No PNG metadata.');
};

/**
 * Copies a PNG while dropping character-card text chunks. Used for display
 * derivatives that must not carry the embedded card payload.
 * @param {Buffer} image PNG image buffer
 * @returns {Buffer} PNG buffer without chara/ccv3 metadata
 */
export const stripCharacterMetadata = (image) => {
    const chunks = extract(image).filter((chunk) => {
        if (chunk.name !== 'tEXt') {
            return true;
        }
        const keyword = readTextChunkKeyword(chunk.data).toLowerCase();
        return keyword !== 'chara' && keyword !== 'ccv3';
    });
    return Buffer.from(encode(chunks));
};

/**
 * Parses a card image and returns the character metadata.
 * @param {string} cardUrl Path to the card image
 * @param {string} format File format
 * @returns {Promise<string>} Character data
 */
export const parse = async (cardUrl, format) => {
    let fileFormat = format === undefined ? 'png' : format;

    switch (fileFormat) {
        case 'png': {
            const buffer = fs.readFileSync(cardUrl);
            return read(buffer);
        }
    }

    throw new Error('Unsupported format');
};

