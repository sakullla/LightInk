/**
 * One tag page for assign, create, rename, and delete.
 * Replaces the small checkbox modal; callers still write through LibraryClient.
 */

export interface TagEditorTag {
  readonly id: string;
  readonly name: string;
}

export type TagEditorFocus = 'assign' | 'name' | 'delete' | 'create';

export interface TagEditorView {
  readonly title: string;
  readonly message: string;
  readonly showMessage: boolean;
  readonly showName: boolean;
  readonly nameLabel: string;
  readonly name: string;
  readonly nameRequired: boolean;
  readonly showOptions: boolean;
  readonly tags: readonly TagEditorTag[];
  readonly checked: ReadonlySet<string>;
  readonly emptyLabel: string;
  readonly showCreate: boolean;
  readonly createPlaceholder: string;
  readonly createLabel: string;
  readonly showDelete: boolean;
  readonly deleteLabel: string;
  readonly showSave: boolean;
  readonly saveLabel: string;
  readonly cancelLabel: string;
  readonly focus: TagEditorFocus;
}

export interface TagEditor {
  readonly element: HTMLElement;
  readonly form: HTMLFormElement;
  open(view: TagEditorView): void;
  close(): void;
  checkedTagIds(): string[];
  nameValue(): string;
  createDraft(): string;
  setCreateDraft(value: string): void;
  setOptions(tags: readonly TagEditorTag[], checked: ReadonlySet<string>, emptyLabel: string): void;
  focusField(focus: TagEditorFocus): void;
}

function button(doc: Document, className: string): HTMLButtonElement {
  const control = doc.createElement('button');
  control.type = 'button';
  control.className = className;
  return control;
}

export function createTagEditor(doc: Document): TagEditor {
  const element = doc.createElement('div');
  element.className = 'lightink-library-tag-editor';
  element.hidden = true;
  element.dataset.tagEditor = 'page';

  const page = doc.createElement('div');
  page.className = 'lightink-library-tag-editor-page';
  page.setAttribute('role', 'dialog');
  page.setAttribute('aria-modal', 'true');

  const form = doc.createElement('form');
  form.className = 'lightink-library-tag-form';

  const title = doc.createElement('h2');
  title.id = 'lightink-library-tag-editor-title';
  page.setAttribute('aria-labelledby', title.id);

  const message = doc.createElement('p');
  message.className = 'lightink-library-tag-confirm';
  message.hidden = true;

  const nameLabel = doc.createElement('label');
  nameLabel.className = 'lightink-library-field';
  const nameLabelText = doc.createElement('span');
  const nameInput = doc.createElement('input');
  nameInput.name = 'tagName';
  nameInput.maxLength = 80;
  nameInput.autocomplete = 'off';
  nameLabel.append(nameLabelText, nameInput);

  const searchInput = doc.createElement('input');
  searchInput.name = 'tagSearch';
  searchInput.autocomplete = 'off';
  searchInput.className = 'lightink-library-tag-search';

  const options = doc.createElement('div');
  options.className = 'lightink-library-tag-options';

  const createRow = doc.createElement('div');
  createRow.className = 'lightink-library-tag-create';
  const createInput = doc.createElement('input');
  createInput.name = 'newTag';
  createInput.maxLength = 80;
  createInput.autocomplete = 'off';
  const createButton = button(doc, 'lightink-library-tag-create-add');
  createButton.dataset.tagEditorAction = 'create';
  createRow.append(createInput, createButton);

  const actions = doc.createElement('div');
  actions.className = 'lightink-library-tag-actions';
  const deleteButton = button(doc, 'lightink-library-danger');
  deleteButton.dataset.tagEditorAction = 'delete';
  const saveButton = button(doc, 'lightink-library-primary');
  saveButton.type = 'submit';
  const cancelButton = button(doc, '');
  cancelButton.dataset.tagEditorAction = 'cancel';
  actions.append(deleteButton, saveButton, cancelButton);

  form.append(title, message, nameLabel, options, createRow, actions);
  page.appendChild(form);
  element.appendChild(page);

  function setOptions(
    tags: readonly TagEditorTag[],
    checked: ReadonlySet<string>,
    emptyLabel: string,
  ): void {
    options.replaceChildren();
    if (tags.length === 0) {
      const empty = doc.createElement('p');
      empty.className = 'lightink-library-tag-empty';
      empty.textContent = emptyLabel;
      options.appendChild(empty);
      return;
    }
    for (const tag of tags) {
      const label = doc.createElement('label');
      label.className = 'lightink-library-tag-option';
      const checkbox = doc.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.name = 'tag';
      checkbox.value = tag.id;
      checkbox.checked = checked.has(tag.id);
      const text = doc.createElement('span');
      text.textContent = tag.name;
      label.append(checkbox, text);
      options.appendChild(label);
    }
    applySearch();
  }

  function applySearch(): void {
    const query = searchInput.value.trim().toLowerCase();
    for (const label of options.querySelectorAll<HTMLLabelElement>('label')) {
      const name = label.textContent?.toLowerCase() ?? '';
      label.hidden = query !== '' && !name.includes(query);
    }
  }

  searchInput.addEventListener('input', () => {
    applySearch();
  });

  function focusField(focus: TagEditorFocus): void {
    const target =
      focus === 'assign'
        ? options.querySelector<HTMLInputElement>('input')
        : focus === 'name'
          ? nameInput
          : focus === 'create'
            ? createInput
            : deleteButton;
    target?.focus();
  }

  return {
    element,
    form,
    open(view: TagEditorView): void {
      title.textContent = view.title;
      message.textContent = view.message;
      nameLabelText.textContent = view.nameLabel;
      nameInput.value = view.name;
      nameInput.required = view.nameRequired;
      createInput.placeholder = view.createPlaceholder;
      createButton.textContent = view.createLabel;
      deleteButton.textContent = view.deleteLabel;
      saveButton.textContent = view.saveLabel;
      cancelButton.textContent = view.cancelLabel;
      searchInput.value = '';
      if (view.showOptions) setOptions(view.tags, view.checked, view.emptyLabel);
      else options.replaceChildren();
      const nodes: Node[] = [title];
      if (view.showMessage) nodes.push(message);
      if (view.showName) nodes.push(nameLabel);
      if (view.showOptions) nodes.push(searchInput, options);
      if (view.showCreate) nodes.push(createRow);
      const actionNodes: Node[] = [];
      if (view.showDelete) actionNodes.push(deleteButton);
      if (view.showSave) actionNodes.push(saveButton);
      actionNodes.push(cancelButton);
      actions.replaceChildren(...actionNodes);
      nodes.push(actions);
      form.replaceChildren(...nodes);
      element.hidden = false;
      focusField(view.focus);
    },
    close(): void {
      element.hidden = true;
      nameInput.required = false;
      createInput.value = '';
      searchInput.value = '';
    },
    checkedTagIds(): string[] {
      return Array.from(
        options.querySelectorAll<HTMLInputElement>('input[name="tag"]:checked'),
      ).map((input) => input.value);
    },
    nameValue(): string {
      return nameInput.value;
    },
    createDraft(): string {
      return createInput.value;
    },
    setCreateDraft(value: string): void {
      createInput.value = value;
    },
    setOptions,
    focusField,
  };
}
