/*
Copyright 2020 mx-puppet-bridge
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at
    http://www.apache.org/licenses/LICENSE-2.0
Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { IDbSchema } from "./dbschema";
import { Store } from "../../store";

export class Schema implements IDbSchema {
	public description = "Add reaction store database";
	public async run(store: Store) {
		await store.createTable(`
			CREATE TABLE reaction_store (
				puppet_id INTEGER NOT NULL,
				room_id TEXT NOT NULL,
				user_id TEXT NOT NULL,
				event_id TEXT NOT NULL,
				reaction_mxid TEXT NOT NULL,
				key TEXT NOT NULL
			);`, "reaction_store");
	}

	public async rollBack(store: Store) {
		await store.db.Exec("DROP TABLE IF EXISTS reaction_store");
	}
}
