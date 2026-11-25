import { ChevronDown } from "lucide-react";
import type { PublicProviderConfig } from "../../shared/contracts";

export function ModelPicker(props: {
  providers: PublicProviderConfig[];
  providerId?: string;
  model?: string;
  onChange: (providerId: string, model: string) => void;
}) {
  const provider = props.providers.find((candidate) => candidate.id === props.providerId) ?? props.providers[0];
  const value = provider && props.model ? `${provider.id}\u0000${props.model}` : "";
  return (
    <label className="model-picker">
      <select
        aria-label="Model"
        value={value}
        disabled={!props.providers.length}
        onChange={(event) => {
          const [providerId, model] = event.target.value.split("\u0000");
          if (providerId && model) props.onChange(providerId, model);
        }}
      >
        {!props.providers.length && <option value="">No provider configured</option>}
        {props.providers.map((candidate) => (
          <optgroup key={candidate.id} label={candidate.name}>
            {candidate.models.map((model) => (
              <option key={model.id} value={`${candidate.id}\u0000${model.id}`}>{model.name}</option>
            ))}
          </optgroup>
        ))}
      </select>
      <ChevronDown size={13} aria-hidden="true" />
    </label>
  );
}
