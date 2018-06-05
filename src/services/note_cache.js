const sql = require('./sql');
const sqlInit = require('./sql_init');
const eventService = require('./events');
const repository = require('./repository');
const protectedSessionService = require('./protected_session');
const utils = require('./utils');

let noteTitles;
let protectedNoteTitles;
let noteIds;
let childParentToBranchId = {};
const childToParent = {};
const hideInAutocomplete = {};

// key is 'childNoteId-parentNoteId' as a replacement for branchId which we don't use here
let prefixes = {};

async function load() {
    noteTitles = await sql.getMap(`SELECT noteId, title FROM notes WHERE isDeleted = 0 AND isProtected = 0`);
    noteIds = Object.keys(noteTitles);

    prefixes = await sql.getMap(`SELECT noteId || '-' || parentNoteId, prefix FROM branches WHERE prefix IS NOT NULL AND prefix != ''`);

    const relations = await sql.getRows(`SELECT branchId, noteId, parentNoteId FROM branches WHERE isDeleted = 0`);

    for (const rel of relations) {
        childToParent[rel.noteId] = childToParent[rel.noteId] || [];
        childToParent[rel.noteId].push(rel.parentNoteId);
        childParentToBranchId[`${rel.noteId}-${rel.parentNoteId}`] = rel.branchId;
    }

    const hiddenLabels = await sql.getColumn(`SELECT noteId FROM labels WHERE isDeleted = 0 AND name = 'hideInAutocomplete'`);

    for (const noteId of hiddenLabels) {
        hideInAutocomplete[noteId] = true;
    }
}

function findNotes(query) {
    if (!noteTitles || query.length <= 2) {
        return [];
    }

    const tokens = query.toLowerCase().split(" ");
    const results = [];

    let noteIds = Object.keys(noteTitles);

    if (protectedSessionService.isProtectedSessionAvailable()) {
        noteIds = noteIds.concat(Object.keys(protectedNoteTitles));
    }

    for (const noteId of noteIds) {
        if (hideInAutocomplete[noteId]) {
            continue;
        }

        const parents = childToParent[noteId];
        if (!parents) {
            continue;
        }

        for (const parentNoteId of parents) {
            if (hideInAutocomplete[parentNoteId]) {
                continue;
            }

            const title = getNoteTitle(noteId, parentNoteId).toLowerCase();
            const foundTokens = [];

            for (const token of tokens) {
                if (title.includes(token)) {
                    foundTokens.push(token);
                }
            }

            if (foundTokens.length > 0) {
                const remainingTokens = tokens.filter(token => !foundTokens.includes(token));

                search(parentNoteId, remainingTokens, [noteId], results);
            }
        }
    }

    results.sort((a, b) => a.title < b.title ? -1 : 1);

    return results;
}

function search(noteId, tokens, path, results) {
    if (tokens.length === 0) {
        const retPath = getSomePath(noteId, path);

        if (retPath) {
            const noteTitle = getNoteTitleForPath(retPath);
            const thisNoteId = retPath[retPath.length - 1];
            const thisParentNoteId = retPath[retPath.length - 2];

            results.push({
                noteId: thisNoteId,
                branchId: childParentToBranchId[`${thisNoteId}-${thisParentNoteId}`],
                title: noteTitle,
                path: retPath.join('/'),
                prefix: prefixes[`${thisNoteId}-${thisParentNoteId}`]
            });
        }

        return;
    }

    const parents = childToParent[noteId];
    if (!parents) {
        return;
    }

    for (const parentNoteId of parents) {
        if (results.length >= 200) {
            return;
        }

        if (parentNoteId === 'root' || hideInAutocomplete[parentNoteId]) {
            continue;
        }

        const title = getNoteTitle(noteId, parentNoteId);
        const foundTokens = [];

        for (const token of tokens) {
            if (title.includes(token)) {
                foundTokens.push(token);
            }
        }

        if (foundTokens.length > 0) {
            const remainingTokens = tokens.filter(token => !foundTokens.includes(token));

            search(parentNoteId, remainingTokens, path.concat([noteId]), results);
        }
        else {
            search(parentNoteId, tokens, path.concat([noteId]), results);
        }
    }
}

function getNoteTitle(noteId, parentNoteId) {
    const prefix = prefixes[noteId + '-' + parentNoteId];

    let title = noteTitles[noteId];

    if (!title) {
        if (protectedSessionService.isProtectedSessionAvailable()) {
            title = protectedNoteTitles[noteId];
        }
        else {
            title = '[protected]';
        }
    }

    return (prefix ? (prefix + ' - ') : '') + title;
}

function getNoteTitleForPath(path) {
    const titles = [];

    let parentNoteId = 'root';

    for (const noteId of path) {
        const title = getNoteTitle(noteId, parentNoteId);

        titles.push(title);
        parentNoteId = noteId;
    }

    return titles.join(' / ');
}

function getSomePath(noteId, path) {
    if (noteId === 'root') {
        path.reverse();

        return path;
    }

    const parents = childToParent[noteId];
    if (!parents || parents.length === 0) {
        return false;
    }

    for (const parentNoteId of parents) {
        if (hideInAutocomplete[parentNoteId]) {
            continue;
        }

        const retPath = getSomePath(parentNoteId, path.concat([noteId]));

        if (retPath) {
            return retPath;
        }
    }

    return false;
}

function getNotePath(noteId) {
    const retPath = getSomePath(noteId, []);

    if (retPath) {
        const noteTitle = getNoteTitleForPath(retPath);

        return {
            noteId: noteId,
            title: noteTitle,
            path: retPath.join('/')
        };
    }
}

eventService.subscribe(eventService.ENTITY_CHANGED, async ({entityName, entityId}) => {
    if (entityName === 'notes') {
        const note = await repository.getNote(entityId);

        if (note.isDeleted) {
            delete noteTitles[note.noteId];
            delete childToParent[note.noteId];
        }
        else {
            noteTitles[note.noteId] = note.title;
        }
    }
    else if (entityName === 'branches') {
        const branch = await repository.getBranch(entityId);

        if (childToParent[branch.noteId]) {
            childToParent[branch.noteId] = childToParent[branch.noteId].filter(noteId => noteId !== branch.parentNoteId)
        }

        if (branch.isDeleted) {
            delete prefixes[branch.noteId + '-' + branch.parentNoteId];
            delete childParentToBranchId[branch.noteId + '-' + branch.parentNoteId];
        }
        else {
            if (branch.prefix) {
                prefixes[branch.noteId + '-' + branch.parentNoteId] = branch.prefix;
            }

            childToParent[branch.noteId] = childToParent[branch.noteId] || [];
            childToParent[branch.noteId].push(branch.parentNoteId);
            childParentToBranchId[branch.noteId + '-' + branch.parentNoteId] = branch.branchId;
        }
    }
    else if (entityName === 'labels') {
        const label = await repository.getLabel(entityId);

        if (label.name === 'hideInAutocomplete') {
            // we're not using label object directly, since there might be other non-deleted hideInAutocomplete label
            const hideLabel = await repository.getEntity(`SELECT * FROM labels WHERE isDeleted = 0 
                                 AND name = 'hideInAutocomplete' AND noteId = ?`, [label.noteId]);

            if (hideLabel) {
                hideInAutocomplete[label.noteId] = true;
            }
            else {
                delete hideInAutocomplete[label.noteId];
            }
        }
    }
});

eventService.subscribe(eventService.ENTER_PROTECTED_SESSION, async () => {
    protectedNoteTitles = await sql.getMap(`SELECT noteId, title FROM notes WHERE isDeleted = 0 AND isProtected = 1`);

    for (const noteId in protectedNoteTitles) {
        protectedNoteTitles[noteId] = protectedSessionService.decryptNoteTitle(noteId, protectedNoteTitles[noteId]);
    }
});

sqlInit.dbReady.then(() => utils.stopWatch("Autocomplete load", load));

module.exports = {
    findNotes,
    getNotePath
};