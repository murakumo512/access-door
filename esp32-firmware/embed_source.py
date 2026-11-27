Import("env")
import hashlib
import os

project_dir = env.subst("$PROJECT_DIR")
src_file = os.path.join(project_dir, "src", "main.cpp")
inc_dir = os.path.join(project_dir, "include")
out_file = os.path.join(inc_dir, "embedded_source.h")

if not os.path.exists(inc_dir):
    os.makedirs(inc_dir)

with open(src_file, "rb") as f:
    raw_bytes = f.read()

sha256_full = hashlib.sha256(raw_bytes).hexdigest()
short_hash = sha256_full[:12]

# Convert raw source bytes into a safe C++ PROGMEM char array so any characters/delimiters in main.cpp are valid
hex_bytes = ", ".join(f"0x{b:02x}" for b in raw_bytes)

header_content = f"""#ifndef EMBEDDED_SOURCE_H
#define EMBEDDED_SOURCE_H

#include <Arduino.h>

#define FIRMWARE_CODE_HASH "{short_hash}"
#define FIRMWARE_CODE_SHA256 "{sha256_full}"
#define EMBEDDED_SOURCE_LEN {len(raw_bytes)}

const char EMBEDDED_SOURCE_CODE[] PROGMEM = {{
  {hex_bytes}, 0x00
}};

#endif
"""

write_needed = True
if os.path.exists(out_file):
    with open(out_file, "r", encoding="utf-8") as f:
        if f.read() == header_content:
            write_needed = False

if write_needed:
    with open(out_file, "w", encoding="utf-8") as f:
        f.write(header_content)
    print(f"[SDN Embed] Updated embedded_source.h (hash={short_hash}, size={len(raw_bytes)} bytes)")
else:
    print(f"[SDN Embed] embedded_source.h up-to-date (hash={short_hash})")
