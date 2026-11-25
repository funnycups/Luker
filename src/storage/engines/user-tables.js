// Child rows precede their parents for foreign-key-safe account deletion.
export const USER_TABLES = Object.freeze([
    'chat_states', 'preset_states', 'chats', 'presets', 'worlds',
    'named_docs', 'groups_table', 'settings', 'stats',
]);

export async function deleteUserRows(connection, handle, placeholder) {
    for (const table of USER_TABLES) {
        await connection.query(`DELETE FROM ${table} WHERE handle = ${placeholder}`, [handle]);
    }
}
