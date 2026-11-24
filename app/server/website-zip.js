import { crc32 } from "node:zlib";
function websiteZip(files) {
  const entries = [], directory = [];
  let offset = 0;
  for (const [path, text] of Object.entries(files)) {
    const name = Buffer.from(path), content = Buffer.from(text), checksum = crc32(content);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(67324752, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(2048, 6);
    header.writeUInt16LE(33, 12);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(content.length, 18);
    header.writeUInt32LE(content.length, 22);
    header.writeUInt16LE(name.length, 26);
    const central2 = Buffer.alloc(46);
    central2.writeUInt32LE(33639248, 0);
    central2.writeUInt16LE(20, 4);
    central2.writeUInt16LE(20, 6);
    central2.writeUInt16LE(2048, 8);
    central2.writeUInt16LE(33, 14);
    central2.writeUInt32LE(checksum, 16);
    central2.writeUInt32LE(content.length, 20);
    central2.writeUInt32LE(content.length, 24);
    central2.writeUInt16LE(name.length, 28);
    central2.writeUInt32LE(offset, 42);
    entries.push(header, name, content);
    directory.push(central2, name);
    offset += header.length + name.length + content.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22), count = Object.keys(files).length;
  end.writeUInt32LE(101010256);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...entries, central, end]);
}
export {
  websiteZip
};
