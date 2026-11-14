import type {WorkspaceClientControllerConstructor} from "@kintsugi/shared";

/** Behaviour only: keep explicit workspace/Agent choices while toggling their submission eligibility. */
export function createMcpAccessController(Controller:WorkspaceClientControllerConstructor){
  return class extends Controller {
    static targets=["transport","http","stdio","mode","choices","count","workspace","workspaceChoice","agentSettings","agentMode","agentChoices"];
    declare readonly element:HTMLElement;
    declare readonly transportTarget:HTMLSelectElement;
    declare readonly httpTarget:HTMLFieldSetElement;
    declare readonly stdioTarget:HTMLFieldSetElement;
    declare readonly modeTarget:HTMLSelectElement;
    declare readonly choicesTarget:HTMLFieldSetElement;
    declare readonly countTarget:HTMLElement;
    declare readonly workspaceTargets:HTMLElement[];
    connect():void{this.sync();}
    sync():void {
      const stdio=this.transportTarget.value==="stdio",allOption=this.modeTarget.querySelector<HTMLOptionElement>('option[value="all"]')!;
      allOption.disabled=stdio;
      if(stdio&&this.modeTarget.value==="all")this.modeTarget.value="workspaces";
      this.httpTarget.hidden=stdio;this.httpTarget.disabled=stdio;
      this.stdioTarget.hidden=!stdio;this.stdioTarget.disabled=!stdio;
      const all=this.modeTarget.value==="all";
      this.choicesTarget.hidden=all;this.choicesTarget.disabled=all;
      let selected=0;
      for(const row of this.workspaceTargets){
        const checkbox=row.querySelector<HTMLInputElement>('[data-mcp-access-target="workspaceChoice"]')!;
        const settings=row.querySelector<HTMLFieldSetElement>('[data-mcp-access-target="agentSettings"]')!;
        const mode=row.querySelector<HTMLSelectElement>('[data-mcp-access-target="agentMode"]')!;
        const agents=row.querySelector<HTMLFieldSetElement>('[data-mcp-access-target="agentChoices"]')!;
        if(checkbox.checked)selected++;
        settings.hidden=!checkbox.checked;settings.disabled=!checkbox.checked;
        agents.hidden=mode.value!=="selected";agents.disabled=mode.value!=="selected";
      }
      this.countTarget.textContent=`${selected} selected`;
    }
  };
}
