import React from "react";
import { Box, Text } from "ink";

type Scalar = string | number | boolean | null | undefined;
type ScalarDict = Record<string, Scalar>;

export type CellProps = React.PropsWithChildren<{
  column: number;
}>;

export type TableProps<T extends ScalarDict> = {
  data: T[];
  columns?: Array<keyof T>;
  padding?: number;
  header?: (props: React.PropsWithChildren<Record<string, unknown>>) => React.ReactElement;
  cell?: (props: CellProps) => React.ReactElement;
  skeleton?: (props: React.PropsWithChildren<Record<string, unknown>>) => React.ReactElement;
};

type Column<T extends ScalarDict> = {
  key: string;
  column: keyof T;
  width: number;
};

type RowProps<T extends ScalarDict> = {
  key: string;
  data: Partial<T>;
  columns: Array<Column<T>>;
};

export function Header(props: React.PropsWithChildren<Record<string, unknown>>) {
  return <Text bold color="cyan" wrap="truncate">{props.children}</Text>;
}

export function Cell(props: CellProps) {
  return <Text wrap="truncate">{props.children}</Text>;
}

export function Skeleton(props: React.PropsWithChildren<Record<string, unknown>>) {
  return <Text bold>{props.children}</Text>;
}

export default function Table<T extends ScalarDict>({
  data,
  columns,
  padding = 1,
  header = Header,
  cell = Cell,
  skeleton = Skeleton,
}: TableProps<T>) {
  const resolvedColumns = columns ?? getDataKeys(data);
  const widths = getColumns(data, resolvedColumns, padding);
  const headings = resolvedColumns.reduce(
    (acc, column) => ({ ...acc, [column]: String(column) }),
    {} as Partial<T>,
  );

  const row = makeRow<T>({ cell, padding, skeleton });
  const headerRow = makeRow<T>({ cell: skeleton, padding, skeleton });
  const separatorRow = makeRow<T>({ cell: skeleton, padding, skeleton });
  const footerRow = makeRow<T>({ cell: skeleton, padding, skeleton });

  return (
    <Box flexDirection="column">
      {headerRow({
        key: "header",
        columns: widths,
        data: {},
        line: "─",
        left: "┌",
        right: "┐",
        cross: "┬",
      })}
      {row({
        key: "heading",
        columns: widths,
        data: headings,
        line: " ",
        left: "│",
        right: "│",
        cross: "│",
      })}
      {data.map((item, index) => (
        <Box flexDirection="column" key={`row-${index}`}>
          {separatorRow({
            key: `separator-${index}`,
            columns: widths,
            data: {},
            line: "─",
            left: "├",
            right: "┤",
            cross: "┼",
          })}
          {row({
            key: `data-${index}`,
            columns: widths,
            data: item,
            line: " ",
            left: "│",
            right: "│",
            cross: "│",
          })}
        </Box>
      ))}
      {footerRow({
        key: "footer",
        columns: widths,
        data: {},
        line: "─",
        left: "└",
        right: "┘",
        cross: "┴",
      })}
    </Box>
  );
}

function getDataKeys<T extends ScalarDict>(data: T[]): Array<keyof T> {
  const keys = new Set<keyof T>();
  for (const item of data) {
    for (const key of Object.keys(item)) {
      keys.add(key as keyof T);
    }
  }
  return [...keys];
}

function getColumns<T extends ScalarDict>(
  data: T[],
  columns: Array<keyof T>,
  padding: number,
): Array<Column<T>> {
  return columns.map((column) => {
    const values = data.map((item) => String(item[column] ?? ""));
    const width =
      Math.max(String(column).length, ...values.map((value) => value.length)) +
      padding * 2;
    return {
      key: String(column),
      column,
      width,
    };
  });
}

function makeRow<T extends ScalarDict>(config: {
  cell: TableProps<T>["cell"];
  padding: number;
  skeleton: TableProps<T>["skeleton"];
}) {
  const skeleton = config.skeleton ?? Skeleton;
  const cell = config.cell ?? Cell;

  return (props: RowProps<T> & {
    line: string;
    left: string;
    right: string;
    cross: string;
  }) => (
    <Box flexDirection="row">
      {skeleton({ children: props.left })}
      {props.columns.map((column, columnIndex) => {
        const value = props.data[column.column];
        const rendered =
          value === undefined || value === null
            ? props.line.repeat(column.width)
            : `${props.line.repeat(config.padding)}${String(value)}${props.line.repeat(
                Math.max(0, column.width - String(value).length - config.padding),
              )}`;
        return (
          <React.Fragment key={`${props.key}-cell-${column.key}`}>
            {columnIndex > 0 ? skeleton({ children: props.cross }) : null}
            {cell({ column: columnIndex, children: rendered })}
          </React.Fragment>
        );
      })}
      {skeleton({ children: props.right })}
    </Box>
  );
}
