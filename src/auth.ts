import { StatusCodes } from "http-status-codes";
import type { ApiClient } from "./api";

interface WorkspaceCredentials {
	name: string;
	password: string;
}

interface AuthToken {
	token: string;
}

export class Auth {
	private client: ApiClient;
	constructor(client: ApiClient) {
		this.client = client;
	}

	async login(name: string, password: string): Promise<AuthToken> {
		const wc: WorkspaceCredentials = { name, password };

		const res = await this.client.post<AuthToken>("/v1/auth/login", wc);

		console.log(res);
		if (res.status !== StatusCodes.OK) {
			throw new Error(`invalid credentials for workspace ${wc.name}`);
		}

		return res.data;
	}
}
