import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);

export function T3Wordmark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  return (
    <Svg
      accessibilityLabel="Vela"
      height={props.height}
      width={props.height}
      viewBox="0 0 24 24"
    >
      <ThemedPath
        d="M12 1.5C13.2 8.2 15.8 10.8 22.5 12C15.8 13.2 13.2 15.8 12 22.5C10.8 15.8 8.2 13.2 1.5 12C8.2 10.8 10.8 8.2 12 1.5Z"
        color={props.color}
        colorClassName={props.colorClassName}
        fill="currentColor"
      />
    </Svg>
  );
}
