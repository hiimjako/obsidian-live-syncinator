import { StatusCodes } from "http-status-codes";
import type { HttpClient } from "./http";

interface WorkspaceCredentials {
	name: string;
	password: string;
}

interface AuthToken {
	token: string;
}

export class Auth {
	private client: HttpClient;
	constructor(client: HttpClient) {
		this.client = client;
	}

	async login(name: string, password: string): Promise<AuthToken> {
		const wc: WorkspaceCredentials = { name, password };

		const res = await this.client.post<AuthToken>("/v1/auth/login", wc);

		if (res.status !== StatusCodes.OK) {
			throw new Error(
				`invalid credentials for workspace ${wc.name}: ${res.data}`,
			);
		}

		return res.data;
	}
}
