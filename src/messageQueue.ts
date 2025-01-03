export class Node<T> {
	public value: T;
	public prev: Node<T> | null;
	public next: Node<T> | null;

	constructor(value: T) {
		this.value = value;
		this.prev = null;
		this.next = null;
	}
}

export class Deque<T> {
	private head: Node<T> | null;
	private tail: Node<T> | null;
	private size: number;

	constructor() {
		this.head = null;
		this.tail = null;
		this.size = 0;
	}

	// Add element to front - O(1)
	public addFront(value: T): this {
		const newNode = new Node<T>(value);

		if (this.isEmpty()) {
			this.head = this.tail = newNode;
		} else {
			newNode.next = this.head;
			// biome-ignore lint/style/noNonNullAssertion: it is checked that exists
			this.head!.prev = newNode;
			this.head = newNode;
		}

		this.size++;
		return this;
	}

	// Add element to back - O(1)
	public addBack(value: T): this {
		const newNode = new Node<T>(value);

		if (this.isEmpty()) {
			this.head = this.tail = newNode;
		} else {
			newNode.prev = this.tail;
			// biome-ignore lint/style/noNonNullAssertion: it is checked that exists
			this.tail!.next = newNode;
			this.tail = newNode;
		}

		this.size++;
		return this;
	}

	// Remove element from front - O(1)
	public removeFront(): T {
		if (this.isEmpty()) {
			throw new Error("Deque is empty");
		}

		// biome-ignore lint/style/noNonNullAssertion: it is checked that exists
		const value = this.head!.value;

		if (this.size === 1) {
			this.head = this.tail = null;
		} else {
			// biome-ignore lint/style/noNonNullAssertion: it is checked that exists
			this.head = this.head!.next;
			// biome-ignore lint/style/noNonNullAssertion: it is checked that exists
			this.head!.prev = null;
		}

		this.size--;
		return value;
	}

	// Remove element from back - O(1)
	public removeBack(): T {
		if (this.isEmpty()) {
			throw new Error("Deque is empty");
		}

		// biome-ignore lint/style/noNonNullAssertion: it is checked that exists
		const value = this.tail!.value;

		if (this.size === 1) {
			this.head = this.tail = null;
		} else {
			// biome-ignore lint/style/noNonNullAssertion: it is checked that exists
			this.tail = this.tail!.prev;
			// biome-ignore lint/style/noNonNullAssertion: it is checked that exists
			this.tail!.next = null;
		}

		this.size--;
		return value;
	}

	// Get front element without removing - O(1)
	public peekFront(): T {
		if (this.isEmpty()) {
			throw new Error("Deque is empty");
		}
		// biome-ignore lint/style/noNonNullAssertion: it is checked that exists
		return this.head!.value;
	}

	// Get back element without removing - O(1)
	public peekBack(): T {
		if (this.isEmpty()) {
			throw new Error("Deque is empty");
		}
		// biome-ignore lint/style/noNonNullAssertion: it is checked that exists
		return this.tail!.value;
	}

	// Check if deque is empty - O(1)
	public isEmpty(): boolean {
		return this.size === 0;
	}

	// Get size of deque - O(1)
	public getSize(): number {
		return this.size;
	}

	// Clear the deque - O(1)
	public clear(): this {
		this.head = null;
		this.tail = null;
		this.size = 0;
		return this;
	}

	// Convert deque to array - O(n)
	public toArray(): T[] {
		const result: T[] = [];
		let current = this.head;

		while (current) {
			result.push(current.value);
			current = current.next;
		}

		return result;
	}

	// Iterator implementation
	public *[Symbol.iterator](): Iterator<T> {
		let current = this.head;
		while (current) {
			yield current.value;
			current = current.next;
		}
	}
}

export class DequeRegistry<K, T> {
	private deques: Map<K, Deque<T>> = new Map();

	// Get or create deque
	getDeque(key: K): Deque<T> {
		if (!this.deques.has(key)) {
			this.deques.set(key, new Deque<T>());
		}
		// biome-ignore lint/style/noNonNullAssertion: it is checked by the has
		return this.deques.get(key)!;
	}

	// Check if a deque exists
	hasDeque(key: K): boolean {
		return this.deques.has(key);
	}

	// Remove a deque
	removeDeque(key: K): boolean {
		return this.deques.delete(key);
	}

	// Clear all deques
	clear(): void {
		this.deques.clear();
	}

	// Get number of deques
	size(): number {
		return this.deques.size;
	}
}
