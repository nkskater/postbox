declare module "postman-code-generators" {
  interface SdkRequest {
    toJSON(): unknown;
  }
  const generators: {
    convert(
      language: string,
      variant: string,
      request: SdkRequest,
      options: Record<string, string | number | boolean>,
      callback: (error: unknown, snippet: string) => void,
    ): void;
    getLanguageList(): { key: string; variants: { key: string }[] }[];
  };
  export default generators;
}
declare module "postman-collection" {
  const sdk: { Request: new (input: unknown) => { toJSON(): unknown } };
  export default sdk;
}
