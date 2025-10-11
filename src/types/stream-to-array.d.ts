declare module "stream-to-array" {
    import { Readable } from "stream";
    function streamToArray(stream: Readable): Promise<Buffer[]>;
    export = streamToArray;
  }
  