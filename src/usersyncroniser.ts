/*
Copyright 2019, 2020 mx-puppet-bridge
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

import { PuppetBridge } from "./puppetbridge";
import { IRemoteUser, IRemoteUserRoomOverride } from "./interfaces";
import { MatrixClient, Intent } from "matrix-bot-sdk";
import { Util } from "./util";
import { Log } from "./log";
import { DbUserStore } from "./db/userstore";
import { IUserStoreEntry, IUserStoreRoomOverrideEntry, IProfileDbEntry } from "./db/interfaces";
import { Lock } from "./structures/lock";
import { ITokenResponse } from "./provisioner";
import { StringFormatter } from "./structures/stringformatter";

const log = new Log("UserSync");

// tslint:disable-next-line:no-magic-numbers
const CLIENT_LOOKUP_LOCK_TIMEOUT = 1000 * 60;

export class UserSyncroniser {
	private userStore: DbUserStore;
	private clientLock: Lock<string>;
	constructor(
		private bridge: PuppetBridge,
	) {
		this.userStore = this.bridge.userStore;
		this.clientLock = new Lock(CLIENT_LOOKUP_LOCK_TIMEOUT);
	}

	public async getClientFromTokenCallback(token: ITokenResponse | null): Promise<MatrixClient | null> {
		if (!token) {
			return null;
		}
		const client = new MatrixClient(token.hsUrl, token.token);
		try {
			await client.getUserId();
			return client;
		} catch (err) {
			log.verbose("Invalid client config");
		}
		return null;
	}

	public async maybeGetClient(data: IRemoteUser): Promise<MatrixClient | null> {
		log.silly("Maybe getting the client");
		const puppetData = await this.bridge.provisioner.get(data.puppetId);
		if (puppetData && puppetData.userId === data.userId) {
			const token = await this.bridge.provisioner.getToken(data.puppetId);
			const puppetClient = await this.getClientFromTokenCallback(token);
			if (puppetClient) {
				return puppetClient;
			}
		}
		const user = await this.userStore.get(data.puppetId, data.userId);
		if (!user) {
			return null;
		}
		const intent = this.bridge.AS.getIntentForSuffix(`${data.puppetId}_${Util.str2mxid(data.userId)}`);
		await intent.ensureRegistered();
		const client = intent.underlyingClient;
		return client;
	}

	public async getPuppetClient(puppetId: number): Promise<MatrixClient | null> {
		const token = await this.bridge.provisioner.getToken(puppetId);
		const puppetClient = await this.getClientFromTokenCallback(token);
		return puppetClient ? puppetClient : null;
	}

	public async getClient(data: IRemoteUser): Promise<MatrixClient> {
		// first we look if we can puppet this user to the matrix side
		log.silly("Start of getClient request");
		const puppetData = await this.bridge.provisioner.get(data.puppetId);
		if (puppetData && puppetData.userId === data.userId) {
			const puppetClient = await this.getPuppetClient(data.puppetId);
			if (puppetClient) {
				return puppetClient;
			}
		}

		// now we fetch the ghost client
		const lockKey = `${data.puppetId};${data.userId}`;
		await this.clientLock.wait(lockKey);
		this.clientLock.set(lockKey);
		log.info("Fetching client for " + data.userId);
		try {
			let user = await this.userStore.get(data.puppetId, data.userId);
			let doUpdate = false;
			let oldProfile: IProfileDbEntry | null = null;
			if (!user) {
				log.info("User doesn't exist yet, creating entry...");
				doUpdate = true;
				// let's fetch the create data via hook
				if (this.bridge.hooks.createUser) {
					log.verbose("Fetching new override data...");
					const newData = await this.bridge.hooks.createUser(data);
					if (newData && newData.userId === data.userId && newData.puppetId === data.puppetId) {
						data = newData;
					} else {
						log.warn("Override data is malformed! Old data:", data, "New data:", newData);
					}
				}
				user = this.userStore.newData(data.puppetId, data.userId);
			} else {
				oldProfile = user;
			}
			const intent = this.bridge.AS.getIntentForSuffix(`${data.puppetId}_${Util.str2mxid(data.userId)}`);
			await intent.ensureRegistered();
			const client = intent.underlyingClient;
			const updateProfile = await Util.ProcessProfileUpdate(
				oldProfile, data, this.bridge.protocol.namePatterns.user,
				async (buffer: Buffer, mimetype?: string, filename?: string) => {
					return await this.bridge.uploadContent(client, buffer, mimetype, filename);
				},
			);
			user = Object.assign(user, updateProfile);
			const promiseList: Promise<void>[] = [];
			if (updateProfile.hasOwnProperty("name")) {
				log.verbose("Updating name");
				// we *don't* await here as setting the name might take a
				// while due to updating all those m.room.member events, we can do that in the BG
				// tslint:disable-next-line:no-floating-promises
				promiseList.push(client.setDisplayName(user.name || ""));
				doUpdate = true;
			}
			if (updateProfile.hasOwnProperty("avatarMxc")) {
				log.verbose("Updating avatar");
				// we *don't* await here as that can take rather long
				// and we might as well do this in the background
				// tslint:disable-next-line:no-floating-promises
				promiseList.push(client.setAvatarUrl(user.avatarMxc || ""));
				doUpdate = true;
			}

			if (doUpdate) {
				log.verbose("Storing update to DB");
				await this.userStore.set(user);
			}

			this.clientLock.release(lockKey);

			// alright, let's wait for name and avatar changes finishing
			Promise.all(promiseList).catch((err) => {
				log.error("Error updating profile", err.error || err.body || err);
			}).then(async () => {
				const roomIdsNotToUpdate: string[] = [];
				// alright, now that we are done creating the user, let's check the room overrides
				if (data.roomOverrides) {
					for (const roomId in data.roomOverrides) {
						if (data.roomOverrides.hasOwnProperty(roomId)) {
							roomIdsNotToUpdate.push(roomId);
							log.verbose(`Got room override for room ${roomId}`);
							// there is no need to await these room-specific changes, might as well do them all at once
							// tslint:disable-next-line:no-floating-promises
							this.updateRoomOverride(client, data, roomId, data.roomOverrides[roomId], user!);
						}
					}
				}

				if (promiseList.length > 0) {
					// name or avatar of the real profile changed, we need to re-apply all our room overrides
					const roomOverrides = await this.userStore.getAllRoomOverrides(data.puppetId, data.userId);
					for (const roomOverride of roomOverrides) {
						if (roomIdsNotToUpdate.includes(roomOverride.roomId)) {
							continue; // nothing to do, we just did this
						}
						// there is no need to await these room-specific changes, might as well do them all at once
						// tslint:disable-next-line:no-floating-promises
						this.setRoomOverride(user!, roomOverride.roomId, roomOverride, client, user!);
					}
				}
			});

			log.verbose("Returning client");
			return client;
		} catch (err) {
			log.error("Error fetching client:", err.error || err.body || err);
			this.clientLock.release(lockKey);
			throw err;
		}
	}

	public getPartsFromMxid(mxid: string): IRemoteUser | null {
		const suffix = this.bridge.AS.getSuffixForUserId(mxid);
		if (!suffix) {
			return null;
		}
		const MXID_MATCH_PUPPET_ID = 1;
		const MXID_MATCH_USER_ID = 2;
		const matches = suffix.match(/^(\d+)_(.*)/);
		if (!matches) {
			return null;
		}
		const puppetId = Number(matches[MXID_MATCH_PUPPET_ID]);
		const userId = Util.mxid2str(matches[MXID_MATCH_USER_ID]);
		if (isNaN(puppetId)) {
			return null;
		}
		return {
			puppetId,
			userId,
		};
	}

	public async deleteForMxid(mxid: string) {
		const user = this.getPartsFromMxid(mxid);
		if (!user) {
			return;
		}
		log.info(`Deleting ghost ${mxid}`);
		await this.userStore.delete(user);
	}

	public async setRoomOverride(
		userData: IRemoteUser,
		roomId: string,
		roomOverrideData?: IUserStoreRoomOverrideEntry | null,
		client?: MatrixClient | null,
		origUserData?: IUserStoreEntry | null,
	) {
		log.info(`Setting room override for puppet ${userData.puppetId} ${userData.userId} in ${roomId}...`);
		if (!client) {
			client = await this.maybeGetClient(userData);
		}
		if (!client) {
			log.warn("No client found");
			return;
		}
		if (!origUserData) {
			origUserData = await this.userStore.get(userData.puppetId, userData.userId);
		}
		if (!origUserData) {
			log.warn("Original user data not found");
			return;
		}
		if (!roomOverrideData) {
			roomOverrideData = await this.userStore.getRoomOverride(userData.puppetId, userData.userId, roomId);
		}
		if (!roomOverrideData) {
			log.warn("No room override data found");
			return;
		}
		const roomMxid = await this.bridge.roomSync.maybeGetMxid({
			puppetId: userData.puppetId,
			roomId,
		});
		if (!roomMxid) {
			log.warn("Room MXID not found");
			return;
		}
		const memberContent = {
			membership: "join",
			displayname: roomOverrideData.name || origUserData.name,
			avatar_url: roomOverrideData.avatarMxc || origUserData.avatarMxc,
		};
		await client.sendStateEvent(roomMxid, "m.room.member", await client.getUserId(), memberContent);
	}

	public async updateRoomOverride(
		client: MatrixClient,
		userData: IRemoteUser,
		roomId: string,
		roomOverride: IRemoteUserRoomOverride,
		origUserData?: IUserStoreEntry,
	) {
		try {
			log.info(`Updating room override for puppet ${userData.puppetId} ${userData.userId} in ${roomId}`);
			let user = await this.userStore.getRoomOverride(userData.puppetId, userData.userId, roomId);
			const newRoomOverride = await Util.ProcessProfileUpdate(
				user, roomOverride, this.bridge.protocol.namePatterns.userOverride,
				async (buffer: Buffer, mimetype?: string, filename?: string) => {
					return await this.bridge.uploadContent(client, buffer, mimetype, filename);
				},
			);
			log.verbose("Update data", newRoomOverride);
			if (!user) {
				user = this.userStore.newRoomOverrideData(userData.puppetId, userData.userId, roomId);
			}
			user = Object.assign(user, newRoomOverride);
			if (newRoomOverride.hasOwnProperty("name") || newRoomOverride.hasOwnProperty("avatarMxc")) {
				try {
					// ok, let's set the override
					await this.setRoomOverride(userData, roomId, user, client, origUserData);
				} catch (err) {
					if (err.body.errcode !== "M_FORBIDDEN") {
						throw err;
					}
				}
				// aaaaand then update the DB
				await this.userStore.setRoomOverride(user);
			}
		} catch (err) {
			log.error(`Error setting room overrides for ${userData.userId} in ${roomId}:`, err.error || err.body || err);
		}
	}
}
