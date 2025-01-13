enum HttpMethod {
    GET = "GET",
    POST = "POST",
    DELETE = "DELETE",
    PATCH = "PATCH",
}

type FetchResponse<T> = {
    data: T;
    status: number;
    headers: Headers;
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

        if (options.method !== HttpMethod.GET) {
            const reqContentType =
                ((options.headers ?? {}) as Record<string, string>)["Content-Type"] ||
                this.defaultHeaders["Content-Type"] ||
                "";

            if (reqContentType.includes("application/json") || reqContentType === "") {
                options.body = JSON.stringify(options.body);
            }
        }

        const response = await fetch(url, {
            ...options,
            headers: {
                ...this.defaultHeaders,
                ...options.headers,
            },
        });

        const status = response.status;

        let data: unknown;
        const contentType = response.headers.get("Content-Type");
        if (response.ok && contentType?.includes("application/json")) {
            data = await response.json();
        } else if (response.ok && contentType?.includes("multipart/mixed")) {
            data = await response.arrayBuffer();
        } else {
            data = await response.text();
        }

        if (!response.ok) {
            throw new Error(`Error: ${status} - ${data} `);
        }

        return { data: data as T, status, headers: response.headers };
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
        body: object | string,
        headers: Record<string, string> = {},
    ): Promise<FetchResponse<T>> {
        return this.request<T>(endpoint, {
            method: HttpMethod.POST,
            headers,
            body: body as BodyInit,
        });
    }

    public patch<T>(
        endpoint: string,
        body: object,
        headers: Record<string, string> = {},
    ): Promise<FetchResponse<T>> {
        return this.request<T>(endpoint, {
            method: HttpMethod.PATCH,
            headers,
            body: body as BodyInit,
        });
    }

    public delete<T>(
        endpoint: string,
        headers: Record<string, string> = {},
    ): Promise<FetchResponse<T>> {
        return this.request<T>(endpoint, {
            method: HttpMethod.DELETE,
            headers,
        });
    }
}
