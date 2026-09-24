
'use strict';

import {CoreInstaller} from 'loopar';

export default class installer extends CoreInstaller {
    constructor(props){
        super(props);
    }

    /**
     * Application roles (seeded idempotently by CoreInstaller.seedRoles).
     * The "<App> Manager" role (everything in this app, nothing else) comes
     * by convention from CoreInstaller — no need to declare it. Sidebar /
     * module visibility is derived from document grants, so no Module grant
     * is needed either. Declared here:
     *  - Web User (base role from loopar, extended): a portal account sees
     *    and lists only its own quotes (CoupleQuoteController resolves
     *    ownership through Couple Customer.email).
     */
    static roles = [
        {
            name: 'Web User',
            grants: [
                {document: 'Couple Quote', action: 'view', scope: 'own'},
                {document: 'Couple Quote', action: 'list', scope: 'own'},
            ],
        },
    ];
}
