export function parseCsvLine(line: string) {
  const values: string[] = [];
  let current = "";
  let insideQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    const nextCharacter = line[index + 1];

    if (character === '"') {
      if (insideQuotes && nextCharacter === '"') {
        current += '"';
        index += 1;
        continue;
      }

      insideQuotes = !insideQuotes;
      continue;
    }

    if (character === "," && !insideQuotes) {
      values.push(current.trim());
      current = "";
      continue;
    }

    current += character;
  }

  values.push(current.trim());
  return values;
}

export function parseCsvText(text: string) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return {
      headers: [] as string[],
      rows: [] as string[][],
    };
  }

  const headers = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map((line) => parseCsvLine(line));

  return { headers, rows };
}

export function valueByHeader(
  headers: string[],
  row: string[] | undefined,
  headerName: string,
) {
  if (!row) {
    return "";
  }

  const index = headers.indexOf(headerName);
  if (index === -1) {
    return "";
  }

  return row[index] ?? "";
}

export function numericValueByHeader(
  headers: string[],
  row: string[] | undefined,
  headerName: string,
  defaultValue = 0,
) {
  const rawValue = valueByHeader(headers, row, headerName);
  const value = Number(rawValue);
  return Number.isFinite(value) ? value : defaultValue;
}
