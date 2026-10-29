"""One fine-tune: QLoRA with Unsloth on the Lab dataset, then a GGUF for Ollama.

Run by server.py as: python train.py <job folder>. The folder holds job.json (settings) and dataset.jsonl
(chat format: {"messages": [system, user, assistant]}). Progress goes to status.json, output to gguf/.
"""

from __future__ import annotations

import inspect
import json
import math
import os
import sys
import time
import traceback
from pathlib import Path

DIR = Path(sys.argv[1])
JOB = json.loads((DIR / "job.json").read_text())
STARTED = time.time()


def status(state: str, **extra) -> None:
    """status.json is what HiveMind shows: state, steps, loss, time left."""
    data = {"state": state, "startedAt": STARTED, "updatedAt": time.time(), **extra}
    tmp = DIR / "status.json.tmp"
    tmp.write_text(json.dumps(data))
    tmp.replace(DIR / "status.json")
    print(f"[status] {state} {json.dumps(extra)[:300]}", flush=True)


def only_known(fn, kwargs: dict) -> dict:
    """Keyword arguments this version of a library accepts (TRL renames them between versions)."""
    params = inspect.signature(fn).parameters
    if any(p.kind is p.VAR_KEYWORD for p in params.values()):
        return kwargs
    return {k: v for k, v in kwargs.items() if k in params}


def main() -> None:
    base = JOB["base"]
    max_len = int(JOB.get("maxSeqLength", 4096))
    status("loading", note=f"Loading {base} in 4-bit")

    import torch

    # GPUs without bfloat16 (Tesla T4): Qwen3.5 gives NaNs in float16, so Unsloth must train in float32 there
    # (its own T4 notebooks do this). The flag has to be set before unsloth is imported.
    bf16 = torch.cuda.is_available() and torch.cuda.is_bf16_supported()
    if not bf16:
        os.environ["UNSLOTH_FORCE_FLOAT32"] = "1"

    from datasets import Dataset
    from transformers import TrainerCallback
    from trl import SFTConfig, SFTTrainer
    from unsloth import FastLanguageModel

    # Unsloth advises 16-bit LoRA for Qwen3.5; from about 4B a 16 GB card needs the 4-bit load.
    load4 = JOB.get("load4bit")
    if load4 is None:
        load4 = any(f"{n}b" in base.lower() for n in ("4", "7", "8", "9", "12", "14"))
    status("loading", note=f"Loading {base} ({'4-bit' if load4 else '16-bit'}{', float32 compute' if not bf16 else ''})")
    model, processor = FastLanguageModel.from_pretrained(model_name=base, max_seq_length=max_len, load_in_4bit=bool(load4), dtype=None)
    # Multimodal bases (Qwen3.5) can come with a processor; text training uses its tokenizer.
    tok = getattr(processor, "tokenizer", processor)
    peft_args = dict(
        r=int(JOB.get("loraRank", 16)),
        lora_alpha=int(JOB.get("loraRank", 16)),
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
        lora_dropout=0,
        bias="none",
        random_state=3407,
        use_gradient_checkpointing="unsloth",
    )
    model = FastLanguageModel.get_peft_model(model, **only_known(FastLanguageModel.get_peft_model, peft_args))
    # LoRA weights that stayed bfloat16 break the float16 grad scaler ("... not implemented for 'BFloat16'").
    if not bf16:
        for p in model.parameters():
            if p.requires_grad and p.dtype == torch.bfloat16:
                p.data = p.data.float()

    rows = [json.loads(line) for line in (DIR / "dataset.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]

    def render(messages: list[dict]) -> str:
        try:
            return tok.apply_chat_template(messages, tokenize=False, enable_thinking=False)
        except TypeError:
            return tok.apply_chat_template(messages, tokenize=False)

    texts = [render(r["messages"]) for r in rows if r.get("messages")]
    if not texts:
        raise RuntimeError("The dataset is empty")
    ds = Dataset.from_dict({"text": texts})

    epochs = float(JOB.get("epochs", 2))
    batch, accum = 1, int(JOB.get("gradAccum", 4))
    total = max(1, math.ceil(len(texts) / (batch * accum)) * math.ceil(epochs))
    if JOB.get("maxSteps"):
        total = int(JOB["maxSteps"])

    class Progress(TrainerCallback):
        def on_log(self, args, state, control, logs=None, **kw):  # noqa: ANN001
            done = state.global_step
            took = time.time() - STARTED
            per = took / done if done else None
            status(
                "training",
                step=done,
                totalSteps=state.max_steps or total,
                epoch=round(state.epoch or 0, 2),
                loss=(logs or {}).get("loss"),
                etaS=round(per * ((state.max_steps or total) - done)) if per else None,
                rows=len(texts),
            )

    cfg = dict(
        output_dir=str(DIR / "checkpoints"),
        dataset_text_field="text",
        max_seq_length=max_len,
        max_length=max_len,
        per_device_train_batch_size=batch,
        gradient_accumulation_steps=accum,
        num_train_epochs=epochs,
        max_steps=int(JOB.get("maxSteps") or -1),
        learning_rate=float(JOB.get("learningRate", 2e-4)),
        warmup_ratio=0.05,
        lr_scheduler_type="linear",
        optim="adamw_8bit",
        weight_decay=0.01,
        fp16=not bf16,
        bf16=bf16,
        logging_steps=1,
        save_strategy="no",
        report_to="none",
        seed=3407,
    )
    args = SFTConfig(**only_known(SFTConfig.__init__, cfg))
    trainer_args = dict(model=model, train_dataset=ds, args=args, callbacks=[Progress()], processing_class=tok, tokenizer=tok)
    trainer = SFTTrainer(**only_known(SFTTrainer.__init__, trainer_args))
    status("training", step=0, totalSteps=total, rows=len(texts), note="Training started")
    result = trainer.train()

    status("exporting", note=f"Making the GGUF ({JOB.get('quant', 'q4_k_m')})", loss=getattr(result, "training_loss", None))
    out = DIR / "gguf"
    out.mkdir(exist_ok=True)
    model.save_pretrained_gguf(str(out), tok, quantization_method=JOB.get("quant", "q4_k_m"))
    ggufs = sorted((p for p in out.rglob("*.gguf") if "mmproj" not in p.name.lower()), key=lambda p: p.stat().st_size, reverse=True)
    if not ggufs:
        raise RuntimeError("Training worked, but no GGUF file was made (llama.cpp export failed — see the log)")
    status(
        "done",
        gguf=str(ggufs[0].relative_to(DIR)),
        sizeBytes=ggufs[0].stat().st_size,
        loss=getattr(result, "training_loss", None),
        rows=len(texts),
        tookS=round(time.time() - STARTED),
    )


if __name__ == "__main__":
    os.environ.setdefault("HF_HOME", "/workspace/.cache/huggingface")
    try:
        main()
    except Exception as err:  # noqa: BLE001 - every failure must reach HiveMind's Problems log
        traceback.print_exc()
        msg = str(err)
        if "out of memory" in msg.lower():
            msg = f"The GPU ran out of memory: {msg[:300]}. Try a smaller base model or a shorter max length."
        status("error", error=msg[:1000])
        sys.exit(1)
