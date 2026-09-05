import React, {
  FunctionComponent,
  ReactElement,
  useEffect,
  useState,
} from "react";
import DashboardVariable, {
  DashboardVariableType,
} from "Common/Types/Dashboard/DashboardVariable";
import MetricUtil from "../../Metrics/Utils/Metrics";

import DashboardVariableControl, {
  VariableValueChange,
} from "Common/UI/Components/Dashboard/DashboardVariableControl";

export type { VariableValueChange } from "Common/UI/Components/Dashboard/DashboardVariableControl";

export interface ComponentProps {
  variables: Array<DashboardVariable>;
  onVariableValueChange: (
    variableId: string,
    change: VariableValueChange,
  ) => void;
}

interface SingleVariableSelectorProps {
  variable: DashboardVariable;
  onVariableValueChange: (
    variableId: string,
    change: VariableValueChange,
  ) => void;
}

const SingleVariableSelector: FunctionComponent<SingleVariableSelectorProps> = (
  props: SingleVariableSelectorProps,
): ReactElement => {
  const { variable } = props;

  const [dynamicOptions, setDynamicOptions] = useState<Array<string>>([]);
  const [isLoadingOptions, setIsLoadingOptions] = useState<boolean>(false);

  /*
   * KugelAudio modification: explicit choices keep telemetry filtering while
   * avoiding a project-wide attribute scan each time a dashboard opens.
   */
  const customListOptions: Array<string> = Array.from(
    new Set(
      (variable.customListValues || "")
        .split(",")
        .map((value: string) => {
          return value.trim();
        })
        .filter((value: string) => {
          return value.length > 0;
        }),
    ),
  );
  const hasConfiguredOptions: boolean = customListOptions.length > 0;

  useEffect(() => {
    let cancelled: boolean = false;
    if (
      variable.type === DashboardVariableType.TelemetryAttribute &&
      variable.attributeKey &&
      !hasConfiguredOptions
    ) {
      setIsLoadingOptions(true);
      MetricUtil.getTelemetryAttributeValues({
        attributeKey: variable.attributeKey,
      })
        .then((values: Array<string>) => {
          if (cancelled) {
            return;
          }
          setDynamicOptions(values);
        })
        .catch(() => {
          if (cancelled) {
            return;
          }
          setDynamicOptions([]);
        })
        .finally(() => {
          if (cancelled) {
            return;
          }
          setIsLoadingOptions(false);
        });
    } else {
      setIsLoadingOptions(false);
    }
    return () => {
      cancelled = true;
    };
  }, [variable.type, variable.attributeKey, hasConfiguredOptions]);

  return (
    <DashboardVariableControl
      variable={variable}
      dynamicOptions={hasConfiguredOptions ? customListOptions : dynamicOptions}
      isLoadingOptions={isLoadingOptions}
      onVariableValueChange={props.onVariableValueChange}
    />
  );
};

const DashboardVariableSelector: FunctionComponent<ComponentProps> = (
  props: ComponentProps,
): ReactElement => {
  if (!props.variables || props.variables.length === 0) {
    return <></>;
  }

  return (
    <div className="flex flex-wrap gap-3 items-center">
      {props.variables.map((variable: DashboardVariable) => {
        return (
          <SingleVariableSelector
            key={variable.id}
            variable={variable}
            onVariableValueChange={props.onVariableValueChange}
          />
        );
      })}
    </div>
  );
};

export default DashboardVariableSelector;
