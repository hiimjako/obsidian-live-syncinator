enum HttpMethod {
	GET = "GET",
	POST = "POST",
	DELETE = "DELETE",
}

type FetchResponse<T> = {
	data: T;
	status: number;
};

export class HttpClient {
	private basePath: string;
	private defaultHeaders: Record<string, string>;

	constructor(
		scheme: "http" | "https",
		domain: string,
		defaultHeaders: Record<string, string> = {},
	) {
		this.basePath = `${scheme}://${domain}`;
		this.defaultHeaders = {
			"Content-Type": "application/json",
			...defaultHeaders,
		};
	}

	private async request<T>(
		endpoint: string,
		options: RequestInit = {},
	): Promise<FetchResponse<T>> {
		const url = new URL(endpoint, this.basePath).toString();
		const response = await fetch(url, {
			...options,
			headers: {
				...this.defaultHeaders,
				...options.headers,
			},
		});

		const status = response.status;
		const data = response.ok ? await response.json() : await response.text();

		if (!response.ok) {
			throw new Error(`Error: ${status} - ${data} `);
		}

		return { data: data as T, status };
	}

	public setAuthorizationHeader(token: string) {
		this.defaultHeaders.Authorization = `Bearer ${token}`;
	}

	public get<T>(
		endpoint: string,
		headers: Record<string, string> = {},
	): Promise<FetchResponse<T>> {
		return this.request<T>(endpoint, { method: HttpMethod.GET, headers });
	}

	public post<T>(
		endpoint: string,
		body: object,
		headers: Record<string, string> = {},
	): Promise<FetchResponse<T>> {
		return this.request<T>(endpoint, {
			method: HttpMethod.POST,
			headers,
			body: JSON.stringify(body),
		});
	}

	public delete<T>(
		endpoint: string,
		headers: Record<string, string> = {},
	): Promise<FetchResponse<T>> {
		return this.request<T>(endpoint, { method: HttpMethod.DELETE, headers });
	}
}
