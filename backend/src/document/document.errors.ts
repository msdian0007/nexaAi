export class DocumentNotFoundError extends Error {
  constructor() {
    super("Document not found");
    this.name = "DocumentNotFoundError";
  }
}

export class DocumentProcessingConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentProcessingConflictError";
  }
}
