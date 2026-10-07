// Create the database before migrations; publish only after the schema is ready.
export async function prepareDeployment(database, run) {
    if (!database.database_id) {
        const databases = JSON.parse(await run(['d1', 'list', '--json'], true));
        if (!Array.isArray(databases)) throw new Error('Unexpected D1 database list response.');
        if (!databases.some(item => item.name === database.database_name)) {
            await run(['d1', 'create', database.database_name, '--no-update-config']);
        }
    }
    await run(['d1', 'migrations', 'apply', database.binding, '--remote']);
}
